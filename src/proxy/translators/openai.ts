/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */

import log from 'electron-log';
import {
  extractGeminiToolDeclarations,
  normalizeToolArgs,
  parseToolCallArgs,
  ToolSchemas,
} from './utils';
import { isTextualInlineMime } from '../modelUtils';
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
  function_response?: GeminiFunctionResponse;
  fileData?: { mimeType?: string; fileUri?: string };
  file_data?: { mime_type?: string; file_uri?: string };
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
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
  parts?: GeminiPart[];
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

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
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
  cachedContentTokenCount?: number;
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

export function usesMaxCompletionTokens(modelName: string): boolean {
  const lowerName = (modelName || '').toLowerCase();
  const isThinkingModel = /thinking|reasoning/i.test(lowerName);
  const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
  const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
  const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
  const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
  return isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
}

function saveModelReasoning(stateKey: string, reasoning: string): void {
  if (!reasoning) return;
  modelReasoningContent.set(stateKey, reasoning);
  touchStateTimestamp(stateTimestamps.reasoning, stateKey);
}

function readInlinePart(part: GeminiPart): { mime: string; data: string } | null {
  const inline = part.inlineData || part.inline_data;
  if (!inline) return null;
  const rawMime =
    ('mimeType' in inline ? inline.mimeType : undefined) || ('mime_type' in inline ? inline.mime_type : undefined) || '';
  const mime = rawMime.split(';')[0].trim().toLowerCase();
  const data = inline.data || '';
  if (!mime || !data) return null;
  return { mime, data };
}

function stripDataUrlPrefix(data: string): string {
  const match = /^data:[^;]+;base64,(.*)$/is.exec(data);
  return match ? match[1] : data;
}

function toDataUrl(mime: string, data: string): string {
  return data.startsWith('data:') ? data : `data:${mime};base64,${data}`;
}

function resolveOpenAIAudioFormat(mime: string): 'wav' | 'mp3' | null {
  if (mime === 'audio/wav' || mime === 'audio/wave' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/mp3' || mime === 'audio/mpeg') return 'mp3';
  return null;
}

function buildOpenAIUserContent(parts: GeminiPart[]): string | OpenAIContentPart[] {
  const textChunks: string[] = [];
  const mediaParts: OpenAIContentPart[] = [];
  let hasMediaParts = false;
  let pdfCounter = 0;

  const flushTextToMulti = () => {
    if (textChunks.length > 0) {
      mediaParts.push({ type: 'text', text: textChunks.join('\n') });
      textChunks.length = 0;
    }
  };

  for (const p of parts) {
    if (p.text && !p.thought) {
      textChunks.push(p.text);
      continue;
    }

    const inline = readInlinePart(p);
    if (inline) {
      const { mime, data } = inline;
      if (isTextualInlineMime(mime)) {
        const decodedText = Buffer.from(stripDataUrlPrefix(data), 'base64').toString('utf-8');
        if (decodedText) textChunks.push(decodedText);
      } else if (mime.startsWith('image/')) {
        hasMediaParts = true;
        flushTextToMulti();
        mediaParts.push({ type: 'image_url', image_url: { url: toDataUrl(mime, data) } });
      } else if (mime === 'application/pdf') {
        hasMediaParts = true;
        pdfCounter += 1;
        flushTextToMulti();
        mediaParts.push({
          type: 'file',
          file: { filename: `document-${pdfCounter}.pdf`, file_data: toDataUrl('application/pdf', data) },
        });
      } else if (mime.startsWith('audio/')) {
        const audioFormat = resolveOpenAIAudioFormat(mime);
        if (audioFormat) {
          hasMediaParts = true;
          flushTextToMulti();
          mediaParts.push({
            type: 'input_audio',
            input_audio: { data: stripDataUrlPrefix(data), format: audioFormat },
          });
        } else {
          textChunks.push(`[Unsupported audio format for OpenAI Chat Completions (${mime}): supports wav and mp3]`);
        }
      } else if (mime.startsWith('video/')) {
        textChunks.push(
          `[Video attachment (${mime}) is not supported by OpenAI Chat Completions; switch to a Google Gemini model to inspect video]`,
        );
      } else {
        textChunks.push(`[Inline data: ${mime}, length: ${data.length} chars]`);
      }
      continue;
    }

    const fd = p.fileData || p.file_data;
    if (fd) {
      const uri = ('fileUri' in fd ? fd.fileUri : undefined) || ('file_uri' in fd ? fd.file_uri : undefined) || '';
      const mime = ('mimeType' in fd ? fd.mimeType : undefined) || ('mime_type' in fd ? fd.mime_type : undefined) || '';
      if (uri) textChunks.push(`[File reference: ${uri} (${mime})]`);
    }
  }

  if (hasMediaParts) {
    flushTextToMulti();
    return mediaParts;
  }
  return textChunks.join('\n');
}

export function mapGeminiToOpenAI(
  geminiBody: GeminiRequestBody,
  modelName: string,
  stateKey = modelName,
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];
  const historyCallIds = new Map<string, string[]>();
  const pendingToolResponseParts: GeminiPart[] = [];
  const flushToolResponseExtras = () => {
    if (!pendingToolResponseParts.length) return;
    const content = buildOpenAIUserContent(pendingToolResponseParts);
    pendingToolResponseParts.length = 0;
    if (typeof content === 'string' ? content : content.length > 0) {
      messages.push({ role: 'user', content });
    }
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
        const hasFunctionResponse = item.parts.some((p) => p.functionResponse || p.function_response);
        if (!hasFunctionResponse) flushToolResponseExtras();

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
            const fnResp = p.functionResponse || p.function_response;
            if (fnResp) {
              const funcName = fnResp.name || '';
              const modelTCIds = modelToolCallIds.get(stateKey) || {};
              const ids = historyCallIds.get(funcName) || [];
              const toolCallId = fnResp.id || ids.shift() || modelTCIds[funcName] || 'call_' + funcName;
              if (fnResp.id) {
                const matched = ids.indexOf(fnResp.id);
                if (matched >= 0) ids.splice(matched, 1);
              }
              const responseData = fnResp.response;
              const contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
              if (Array.isArray(fnResp.parts)) {
                for (const nestedPart of fnResp.parts) {
                  if (
                    !nestedPart.thought &&
                    (nestedPart.text ||
                      nestedPart.inlineData ||
                      nestedPart.inline_data ||
                      nestedPart.fileData ||
                      nestedPart.file_data)
                  ) {
                    pendingToolResponseParts.push(nestedPart);
                  }
                }
              }
            } else if (!p.thought && (p.text || p.inlineData || p.inline_data || p.fileData || p.file_data)) {
              pendingToolResponseParts.push(p);
            }
          }
        } else {
          const role = item.role === 'model' ? 'assistant' : item.role || 'user';
          let content: string | OpenAIContentPart[] = '';
          let reasoning_content = '';
          if (role === 'assistant') {
            const regularParts = (item.parts || []).filter((p) => !p.thought);
            const thoughtParts = (item.parts || []).filter((p) => p.thought);
            content = regularParts.map((p) => p.text || '').join('');
            reasoning_content = thoughtParts.map((p) => p.text || '').join('');
          } else {
            content = buildOpenAIUserContent(item.parts || []);
          }
          const msg: OpenAIMessage = { role, content };
          if (reasoning_content) msg.reasoning_content = reasoning_content;
          messages.push(msg);
        }
      }
    }
  }
  // Keep feedback and non-text parts (such as images) after all consecutive tool results.
  flushToolResponseExtras();

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

  const lowerName = modelName.toLowerCase();
  const isThinkingModel = /thinking|reasoning/i.test(lowerName);
  const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
  const needsCompletionTokens = usesMaxCompletionTokens(modelName);
  const needsNoTemperature = isThinkingModel || isReasoningModel;

  const explicitTemp = geminiBody.generationConfig?.temperature;
  const maxTokens = geminiBody.generationConfig?.maxOutputTokens;
  const payload: OpenAIRequestBody = {
    model: modelName,
    messages,
    ...(needsNoTemperature || explicitTemp === undefined ? {} : { temperature: explicitTemp }),
    ...(maxTokens !== undefined
      ? needsCompletionTokens
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }
      : {}),
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

function buildOpenAIUsageMetadata(usage?: OpenAIResponse['usage']): GeminiUsageMetadata {
  const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens || 0);
  return {
    promptTokenCount: usage?.prompt_tokens || 0,
    candidatesTokenCount: usage?.completion_tokens || 0,
    totalTokenCount: usage?.total_tokens || 0,
    ...(cachedTokens > 0 ? { cachedContentTokenCount: cachedTokens } : {}),
  };
}

export function mapOpenAIToGemini(
  openAiRes: OpenAIResponse,
  modelName: string,
  toolSchemas?: ToolSchemas,
): GeminiGenerateContentResponse {
  const choice = openAiRes.choices?.[0];
  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  if (reasoning) saveModelReasoning(modelName, reasoning);
  const usageMetadata = buildOpenAIUsageMetadata(openAiRes.usage);

  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const parts: GeminiPart[] = choice.message.tool_calls.map((tc) =>
      buildGeminiToolCallPart(tc.function.name, tc.function.arguments, tc.id, modelName, toolSchemas),
    );
    if (choice.message.content) parts.unshift({ text: choice.message.content });
    if (reasoning) parts.unshift({ text: reasoning, thought: true });
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
      usageMetadata,
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
      usageMetadata,
    };
  }

  const parts: GeminiPart[] = [];
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (text) parts.push({ text });
  const finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
    usageMetadata,
  };
}

// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────

function flushOpenAIContext(
  context: { accumulatedText: string; accumulatedReasoning: string; toolCalls: Record<number, { id: string; name: string; arguments: string }> },
  streamId: string,
  modelName: string,
  toolSchemas: ToolSchemas | undefined,
  inlineReasoning: string,
  upstreamFinishReason?: string,
): GeminiCandidate {
  saveModelReasoning(modelName, context.accumulatedReasoning);
  const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => Boolean(tc.name));
  const remainingText = context.accumulatedText;
  context.accumulatedText = '';
  activeStreamContexts.delete(streamId);

  const isToolFinish =
    pendingToolCalls.length > 0 ||
    upstreamFinishReason === 'tool_calls' ||
    upstreamFinishReason === 'tool_call' ||
    upstreamFinishReason === 'function_call';

  if (isToolFinish) {
    const parts: GeminiPart[] = pendingToolCalls.map((tc) =>
      buildGeminiToolCallPart(tc.name, tc.arguments, tc.id, modelName, toolSchemas),
    );
    if (remainingText) parts.unshift({ text: remainingText });
    if (inlineReasoning) parts.unshift({ text: inlineReasoning, thought: true });
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  const parts: GeminiPart[] = [];
  if (inlineReasoning) parts.push({ text: inlineReasoning, thought: true });
  if (remainingText) parts.push({ text: remainingText });
  return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
}

/**
 * Дожимает оставшиеся в буфере SSE-стрима toolCalls, DSML-теги или текст,
 * если апстрим закрыл поток по [DONE]/EOF без финального finish_reason.
 */
export function flushOpenAIStreamRemainder(
  streamKey: string,
  modelName: string,
  toolSchemas?: ToolSchemas,
): GeminiCandidate | null {
  const context = activeStreamContexts.get(streamKey);
  if (!context) return null;

  const dsml = parseDSMLToolCalls(context.accumulatedText);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = dsml.functionCalls.map((fc) =>
      buildGeminiToolCallPart(fc.name, fc.args, undefined, modelName, toolSchemas),
    );
    if (dsml.cleanText) parts.unshift({ text: dsml.cleanText });
    context.accumulatedText = '';
    saveModelReasoning(modelName, context.accumulatedReasoning);
    activeStreamContexts.delete(streamKey);
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  const hasToolCalls = Object.values(context.toolCalls).some((tc) => Boolean(tc.name));
  if (!hasToolCalls && !context.accumulatedText) {
    saveModelReasoning(modelName, context.accumulatedReasoning);
    activeStreamContexts.delete(streamKey);
    return null;
  }

  return flushOpenAIContext(context, streamKey, modelName, toolSchemas, '');
}

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
  if (finishReason) {
    return flushOpenAIContext(context, streamId, modelName, toolSchemas, reasoning, finishReason);
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
