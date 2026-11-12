/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */

import * as path from 'path';
import log from 'electron-log';
import {
  extractGeminiToolDeclarations,
  normalizeToolArgs,
  parseToolCallArgs,
  ToolSchemas,
} from './utils';
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  stateTimestamps,
  touchStateTimestamp,
} from '../shared';

// ─── Types ────────────────────────────────────────────────────────────────

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: GeminiParameters;
  parametersJsonSchema?: Record<string, unknown>;
}

interface GeminiParameters {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  fileData?: { mimeType: string; fileUri: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

interface GeminiFunctionResponse {
  name: string;
  response: unknown;
  id?: string;
}

interface GeminiRequestBody {
  systemInstruction?: { parts: GeminiPart[] };
  contents?: GeminiContent[];
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  stream?: boolean;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIChoice {
  message?: {
    content: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCallDelta[];
  };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason: string;
  index: number;
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface DSMLParsedResult {
  functionCalls: { name: string; args: Record<string, unknown> }[];
  cleanText: string;
}

// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────

function mapGeminiToolsToOpenAI(geminiTools: GeminiTool[]): OpenAITool[] {
  return extractGeminiToolDeclarations(geminiTools).map((decl) => ({
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
    },
  }));
}

function buildGeminiToolCallPart(
  name: string,
  rawArgs: unknown,
  callId: string | undefined,
  stateKey: string,
  toolSchemas?: ToolSchemas,
): GeminiPart {
  const parsedArgs = parseToolCallArgs(rawArgs);
  const normalizedArgs = normalizeToolArgs(name, parsedArgs, toolSchemas);
  if (callId) {
    const modelTCIds = modelToolCallIds.get(stateKey) || {};
    modelTCIds[name] = callId;
    modelToolCallIds.set(stateKey, modelTCIds);
    touchStateTimestamp(stateTimestamps.toolCallIds, stateKey);
  }
  return {
    functionCall: {
      name,
      args: normalizedArgs,
      ...(callId ? { id: callId } : {}),
    },
  };
}

function saveModelReasoning(stateKey: string, reasoning: string): void {
  if (!reasoning) return;
  modelReasoningContent.set(stateKey, reasoning);
  touchStateTimestamp(stateTimestamps.reasoning, stateKey);
}

export function mapGeminiToOpenAI(
  geminiBody: GeminiRequestBody,
  modelName: string,
  stateKey = modelName,
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];
  const historyCallIds = new Map<string, string[]>();
  const pendingToolResponseTexts: string[] = [];
  const flushToolResponseTexts = () => {
    if (!pendingToolResponseTexts.length) return;
    messages.push({ role: 'user', content: pendingToolResponseTexts.join('\n') });
    pendingToolResponseTexts.length = 0;
  };

  if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
    const systemText = geminiBody.systemInstruction.parts
      .map((p) => p.text || '')
      .filter(Boolean)
      .join('\n\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (geminiBody.contents) {
    for (const item of geminiBody.contents) {
      if (item.parts) {
        const hasFunctionCall = item.parts.some((p) => p.functionCall);
        const hasFunctionResponse = item.parts.some((p) => p.functionResponse);
        if (!hasFunctionResponse) flushToolResponseTexts();

        if (hasFunctionCall && item.role === 'model') {
          const toolCalls: OpenAIToolCall[] = [];
          for (const p of item.parts) {
            if (p.functionCall) {
              const callId = p.functionCall.id || 'call_' + Math.random().toString(36).slice(2, 10);
              const ids = historyCallIds.get(p.functionCall.name) || [];
              ids.push(callId);
              historyCallIds.set(p.functionCall.name, ids);
              toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                  name: p.functionCall.name,
                  arguments:
                    typeof p.functionCall.args === 'string'
                      ? p.functionCall.args
                      : JSON.stringify(p.functionCall.args || {}),
                },
              });
            }
          }
          const text = item.parts
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text)
            .join('');
          messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
        } else if (hasFunctionResponse) {
          for (const p of item.parts) {
            if (p.text && !p.thought) pendingToolResponseTexts.push(p.text);
            if (p.functionResponse) {
              const funcName = p.functionResponse.name || '';
              const modelTCIds = modelToolCallIds.get(stateKey) || {};
              const ids = historyCallIds.get(funcName) || [];
              const toolCallId = p.functionResponse.id || ids.shift() || modelTCIds[funcName] || 'call_' + funcName;
              if (p.functionResponse.id) {
                const matched = ids.indexOf(p.functionResponse.id);
                if (matched >= 0) ids.splice(matched, 1);
              }
              const responseData = p.functionResponse.response;
              const contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
            }
          }
        } else {
          const role = item.role === 'model' ? 'assistant' : item.role || 'user';
          let content = '';
          let reasoning_content = '';
          if (role === 'assistant') {
            const regularParts = (item.parts || []).filter((p) => !p.thought);
            const thoughtParts = (item.parts || []).filter((p) => p.thought);
            content = regularParts.map((p) => p.text || '').join('');
            reasoning_content = thoughtParts.map((p) => p.text || '').join('');
          } else {
            const parts = item.parts || [];
            const partsContent: string[] = [];
            for (const p of parts) {
              if (p.text) {
                partsContent.push(p.text);
              } else if (p.fileData) {
                const fd = p.fileData as { mimeType: string; fileUri: string };
                // Try to read local files directly
                try {
                  const url = new URL(fd.fileUri);
                  if (url.protocol === 'file:') {
                    const fs = require('fs');
                    const fileContent = fs.readFileSync(
                      url.pathname.replace(/^\//, '').replace(/\//g, path.sep),
                      'utf-8',
                    );
                    partsContent.push(`[File content from ${fd.fileUri}]:\n${fileContent}`);
                  } else {
                    partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                  }
                } catch {
                  partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                }
              } else if (p.inlineData) {
                const id = p.inlineData as { mimeType: string; data: string };
                if (id.mimeType && id.mimeType.startsWith('image/')) {
                  partsContent.push(`[Image: data:${id.mimeType};base64,${id.data}]`);
                } else {
                  partsContent.push(`[Inline data: ${id.mimeType}, length: ${(id.data || '').length} chars]`);
                }
              }
            }
            content = partsContent.join('\n');
          }
          const msg: OpenAIMessage = { role, content };
          if (reasoning_content) msg.reasoning_content = reasoning_content;
          messages.push(msg);
        }
      }
    }
  }
  // Keep feedback after all consecutive tool results, including split parallel responses.
  flushToolResponseTexts();

  // Inject reasoning_content into assistant messages missing it.
  // Поле не пишется, когда значения нет: неизвестное бэкенду пустое поле
  // приводит к HTTP 400 invalid_request (проверено на GPT-6.1 Sol 12.11.2026).
  let lastAssistantIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') lastAssistantIdx = i;
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !(messages[i] as OpenAIMessage).reasoning_content) {
      const preservedReasoning = modelReasoningContent.get(stateKey) || '';
      if (i === lastAssistantIdx && preservedReasoning) {
        messages[i].reasoning_content = preservedReasoning;
      } else {
        delete (messages[i] as OpenAIMessage).reasoning_content;
      }
    }
  }

  // Models requiring max_completion_tokens instead of max_tokens:
  // - Legacy o-series: o1, o3, o4-mini (any format: o1, o1-mini, openai/o3, etc.)
  // - Legacy gpt-4.1 series: gpt-4.1, 4.1-mini, gpt-4.1-nano (any prefix)
  // - GPT-5.x thinking/pro: gpt-5.4-thinking, gpt-5.5-pro, etc.
  //   (OpenAI unified under GPT-5.x in Feb 2026, deprecated all previous models)
  const lowerName = modelName.toLowerCase();
  const isThinkingModel = /thinking|reasoning/i.test(lowerName);
  const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
  const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
  const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
  const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
  const needsCompletionTokens = isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
  const needsNoTemperature = isThinkingModel || isReasoningModel;

  const maxTokens = geminiBody.generationConfig?.maxOutputTokens ?? 4000;
  const payload: OpenAIRequestBody = {
    model: modelName,
    messages,
    ...(needsNoTemperature ? {} : { temperature: geminiBody.generationConfig?.temperature ?? 0.7 }),
    ...(needsCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
  };

  if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
    const openaiTools = mapGeminiToolsToOpenAI(geminiBody.tools);
    if (openaiTools.length > 0) payload.tools = openaiTools;
  }

  return payload;
}

// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────

// Проверяет, начался ли в потоке DSML-блок (ASCII `|` или полноширинная `｜` U+FF5C), который ещё не завершён.
function hasPendingDSMLMarker(text: string): boolean {
  return /<(?:｜)?DSML(?:[|｜]|$)/.test(text) || /<(?:｜(?:D(?:S(?:M(?:L)?)?)?)?|D(?:S(?:M)?)?)$/.test(text);
}

function parseDSMLToolCalls(text: string): DSMLParsedResult | null {
  try {
    const invokeRegex = /<(?:｜)?DSML[|｜]invoke name="([^"]+)">([\s\S]*?)<\/(?:｜)?DSML[|｜]invoke>/g;
    const functionCalls: { name: string; args: Record<string, unknown> }[] = [];
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = invokeRegex.exec(text)) !== null) {
      const funcName = invokeMatch[1];
      const paramsBlock = invokeMatch[2];
      const args: Record<string, unknown> = {};
      const paramRegex = /<(?:｜)?DSML[|｜]parameter name="([^"]+)"(?: string="([^"]+)")?>([\s\S]*?)<\/(?:｜)?DSML[|｜]parameter>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
        const paramName = paramMatch[1];
        let paramValue: unknown = paramMatch[3].trim();
        const isString = paramMatch[2] === 'true';
        if (!isString) {
          try {
            paramValue = JSON.parse(paramValue as string);
          } catch (e) {
            log.debug('[OpenAI] DSML param parse fallback:', (e as Error).message); /* keep as string */
          }
        }
        args[paramName] = paramValue;
      }
      functionCalls.push({ name: funcName, args });
    }
    if (functionCalls.length === 0) return null;
    log.info(
      `[Proxy] Detected ${functionCalls.length} DSML tool call(s): ${functionCalls.map((f) => f.name).join(', ')}`,
    );
    let cleanText = text;
    cleanText = cleanText.replace(
      /<(?:｜)?DSML[|｜](?:tool_calls|function_calls)>[\s\S]*?<\/(?:｜)?DSML[|｜](?:tool_calls|function_calls)>/g,
      '',
    );
    cleanText = cleanText.replace(/<(?:｜)?DSML[|｜]invoke name="[^"]+">[\s\S]*?<\/(?:｜)?DSML[|｜]invoke>/g, '');
    cleanText = cleanText.trim();
    return { functionCalls, cleanText };
  } catch (e) {
    log.error('[Proxy] Failed to parse DSML tool calls:', e);
    return null;
  }
}

export function mapOpenAIToGemini(
  openAiRes: OpenAIResponse,
  modelName: string,
  toolSchemas?: ToolSchemas,
): GeminiGenerateContentResponse {
  const choice = openAiRes.choices?.[0];
  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  if (reasoning) saveModelReasoning(modelName, reasoning);

  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const parts: GeminiPart[] = choice.message.tool_calls.map((tc) =>
      buildGeminiToolCallPart(tc.function.name, tc.function.arguments, tc.id, modelName, toolSchemas),
    );
    if (choice.message.content) parts.unshift({ text: choice.message.content });
    if (reasoning) parts.unshift({ text: reasoning, thought: true });
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  const text = choice?.message?.content || '';
  const dsml = parseDSMLToolCalls(text);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = dsml.functionCalls.map((fc) =>
      buildGeminiToolCallPart(fc.name, fc.args, undefined, modelName, toolSchemas),
    );
    if (dsml.cleanText) parts.unshift({ text: dsml.cleanText });
    if (reasoning) parts.unshift({ text: reasoning, thought: true });
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  const parts: GeminiPart[] = [];
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (text) parts.push({ text });
  const finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
      candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
      totalTokenCount: openAiRes.usage?.total_tokens || 0,
    },
  };
}

// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────

export function mapOpenAIChunkToGemini(
  chunk: OpenAIResponse,
  modelName: string,
  streamKey?: string,
  toolSchemas?: ToolSchemas,
): GeminiCandidate | null {
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta;
  const streamId = streamKey || ((chunk as Record<string, unknown>).id as string) || 'default_stream';

  if (!activeStreamContexts.has(streamId)) {
    activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
    touchStateTimestamp(stateTimestamps.streamCtx, streamId);
  }
  const context = activeStreamContexts.get(streamId)!;

  if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!context.toolCalls[idx]) context.toolCalls[idx] = { id: '', name: '', arguments: '' };
      if (tc.id) context.toolCalls[idx].id = tc.id;
      if (tc.function?.name) context.toolCalls[idx].name += tc.function.name;
      if (tc.function?.arguments) context.toolCalls[idx].arguments += tc.function.arguments;
    }
  }

  const text = delta?.content || '';
  const reasoning = delta?.reasoning_content || delta?.reasoning || '';
  if (reasoning) context.accumulatedReasoning += reasoning;
  if (text) context.accumulatedText += text;

  const dsml = parseDSMLToolCalls(context.accumulatedText);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = dsml.functionCalls.map((fc) =>
      buildGeminiToolCallPart(fc.name, fc.args, undefined, modelName, toolSchemas),
    );
    if (dsml.cleanText) parts.unshift({ text: dsml.cleanText });
    if (reasoning) parts.unshift({ text: reasoning, thought: true });
    context.accumulatedText = '';
    if (choice.finish_reason) {
      saveModelReasoning(modelName, context.accumulatedReasoning);
      activeStreamContexts.delete(streamId);
    }
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  const finishReason = choice.finish_reason;
  if (finishReason === 'stop' || finishReason === 'length') {
    saveModelReasoning(modelName, context.accumulatedReasoning);
    const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => tc.name && tc.arguments);
    if (pendingToolCalls.length > 0) {
      const parts: GeminiPart[] = pendingToolCalls.map((tc) =>
        buildGeminiToolCallPart(tc.name, tc.arguments, tc.id, modelName, toolSchemas),
      );
      if (reasoning) parts.unshift({ text: reasoning, thought: true });
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
    }
    const remainingText = context.accumulatedText;
    context.accumulatedText = '';
    activeStreamContexts.delete(streamId);
    const parts: GeminiPart[] = [];
    if (reasoning) parts.push({ text: reasoning, thought: true });
    if (remainingText) parts.push({ text: remainingText });
    return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
  }

  if (finishReason === 'tool_calls') {
    saveModelReasoning(modelName, context.accumulatedReasoning);
    const parts: GeminiPart[] = Object.values(context.toolCalls).map((tc) =>
      buildGeminiToolCallPart(tc.name, tc.arguments, tc.id, modelName, toolSchemas),
    );
    if (reasoning) parts.unshift({ text: reasoning, thought: true });
    activeStreamContexts.delete(streamId);
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  const streamParts: GeminiPart[] = [];
  if (reasoning) streamParts.push({ text: reasoning, thought: true });
  // Придерживаем текст только если начался DSML-тег, чтобы не выплюнуть сырую разметку в интерфейс.
  if (context.accumulatedText && !hasPendingDSMLMarker(context.accumulatedText)) {
    streamParts.push({ text: context.accumulatedText });
    context.accumulatedText = '';
  }

  if (streamParts.length > 0) {
    return { content: { parts: streamParts, role: 'model' }, finishReason: 'OTHER', index: 0 };
  }

  return null;
}

export { mapGeminiToolsToOpenAI };
