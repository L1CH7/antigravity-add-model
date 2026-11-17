"use strict";
/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.usesMaxCompletionTokens = usesMaxCompletionTokens;
exports.mapGeminiToOpenAI = mapGeminiToOpenAI;
exports.mapOpenAIToGemini = mapOpenAIToGemini;
exports.mapOpenAIChunkToGemini = mapOpenAIChunkToGemini;
exports.mapGeminiToolsToOpenAI = mapGeminiToolsToOpenAI;
const electron_log_1 = __importDefault(require("electron-log"));
const utils_1 = require("./utils");
const modelUtils_1 = require("../modelUtils");
const shared_1 = require("../shared");
// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────
function mapGeminiToolsToOpenAI(geminiTools) {
    return (0, utils_1.extractGeminiToolDeclarations)(geminiTools).map((decl) => ({
        type: 'function',
        function: {
            name: decl.name,
            description: decl.description,
            parameters: decl.parameters,
        },
    }));
}
function buildGeminiToolCallPart(name, rawArgs, callId, stateKey, toolSchemas) {
    const parsedArgs = (0, utils_1.parseToolCallArgs)(rawArgs);
    const normalizedArgs = (0, utils_1.normalizeToolArgs)(name, parsedArgs, toolSchemas);
    if (callId) {
        const modelTCIds = shared_1.modelToolCallIds.get(stateKey) || {};
        modelTCIds[name] = callId;
        shared_1.modelToolCallIds.set(stateKey, modelTCIds);
        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, stateKey);
    }
    return {
        functionCall: {
            name,
            args: normalizedArgs,
            ...(callId ? { id: callId } : {}),
        },
    };
}
function usesMaxCompletionTokens(modelName) {
    const lowerName = (modelName || '').toLowerCase();
    const isThinkingModel = /thinking|reasoning/i.test(lowerName);
    const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
    const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
    const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
    const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
    return isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
}
function saveModelReasoning(stateKey, reasoning) {
    if (!reasoning)
        return;
    shared_1.modelReasoningContent.set(stateKey, reasoning);
    (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.reasoning, stateKey);
}
function readInlinePart(part) {
    const inline = part.inlineData || part.inline_data;
    if (!inline)
        return null;
    const rawMime = ('mimeType' in inline ? inline.mimeType : undefined) || ('mime_type' in inline ? inline.mime_type : undefined) || '';
    const mime = rawMime.split(';')[0].trim().toLowerCase();
    const data = inline.data || '';
    if (!mime || !data)
        return null;
    return { mime, data };
}
function stripDataUrlPrefix(data) {
    const match = /^data:[^;]+;base64,(.*)$/is.exec(data);
    return match ? match[1] : data;
}
function toDataUrl(mime, data) {
    return data.startsWith('data:') ? data : `data:${mime};base64,${data}`;
}
function resolveOpenAIAudioFormat(mime) {
    if (mime === 'audio/wav' || mime === 'audio/wave' || mime === 'audio/x-wav')
        return 'wav';
    if (mime === 'audio/mp3' || mime === 'audio/mpeg')
        return 'mp3';
    return null;
}
function buildOpenAIUserContent(parts) {
    const textChunks = [];
    const mediaParts = [];
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
            if ((0, modelUtils_1.isTextualInlineMime)(mime)) {
                const decodedText = Buffer.from(stripDataUrlPrefix(data), 'base64').toString('utf-8');
                if (decodedText)
                    textChunks.push(decodedText);
            }
            else if (mime.startsWith('image/')) {
                hasMediaParts = true;
                flushTextToMulti();
                mediaParts.push({ type: 'image_url', image_url: { url: toDataUrl(mime, data) } });
            }
            else if (mime === 'application/pdf') {
                hasMediaParts = true;
                pdfCounter += 1;
                flushTextToMulti();
                mediaParts.push({
                    type: 'file',
                    file: { filename: `document-${pdfCounter}.pdf`, file_data: toDataUrl('application/pdf', data) },
                });
            }
            else if (mime.startsWith('audio/')) {
                const audioFormat = resolveOpenAIAudioFormat(mime);
                if (audioFormat) {
                    hasMediaParts = true;
                    flushTextToMulti();
                    mediaParts.push({
                        type: 'input_audio',
                        input_audio: { data: stripDataUrlPrefix(data), format: audioFormat },
                    });
                }
                else {
                    textChunks.push(`[Unsupported audio format for OpenAI Chat Completions (${mime}): supports wav and mp3]`);
                }
            }
            else if (mime.startsWith('video/')) {
                textChunks.push(`[Video attachment (${mime}) is not supported by OpenAI Chat Completions; switch to a Google Gemini model to inspect video]`);
            }
            else {
                textChunks.push(`[Inline data: ${mime}, length: ${data.length} chars]`);
            }
            continue;
        }
        const fd = p.fileData || p.file_data;
        if (fd) {
            const uri = ('fileUri' in fd ? fd.fileUri : undefined) || ('file_uri' in fd ? fd.file_uri : undefined) || '';
            const mime = ('mimeType' in fd ? fd.mimeType : undefined) || ('mime_type' in fd ? fd.mime_type : undefined) || '';
            if (uri)
                textChunks.push(`[File reference: ${uri} (${mime})]`);
        }
    }
    if (hasMediaParts) {
        flushTextToMulti();
        return mediaParts;
    }
    return textChunks.join('\n');
}
function mapGeminiToOpenAI(geminiBody, modelName, stateKey = modelName) {
    const messages = [];
    const historyCallIds = new Map();
    const pendingToolResponseParts = [];
    const flushToolResponseExtras = () => {
        if (!pendingToolResponseParts.length)
            return;
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
                if (!hasFunctionResponse)
                    flushToolResponseExtras();
                if (hasFunctionCall && item.role === 'model') {
                    const toolCalls = [];
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
                                    arguments: typeof p.functionCall.args === 'string'
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
                }
                else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        const fnResp = p.functionResponse || p.function_response;
                        if (fnResp) {
                            const funcName = fnResp.name || '';
                            const modelTCIds = shared_1.modelToolCallIds.get(stateKey) || {};
                            const ids = historyCallIds.get(funcName) || [];
                            const toolCallId = fnResp.id || ids.shift() || modelTCIds[funcName] || 'call_' + funcName;
                            if (fnResp.id) {
                                const matched = ids.indexOf(fnResp.id);
                                if (matched >= 0)
                                    ids.splice(matched, 1);
                            }
                            const responseData = fnResp.response;
                            const contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
                            messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
                            if (Array.isArray(fnResp.parts)) {
                                for (const nestedPart of fnResp.parts) {
                                    if (!nestedPart.thought &&
                                        (nestedPart.text ||
                                            nestedPart.inlineData ||
                                            nestedPart.inline_data ||
                                            nestedPart.fileData ||
                                            nestedPart.file_data)) {
                                        pendingToolResponseParts.push(nestedPart);
                                    }
                                }
                            }
                        }
                        else if (!p.thought && (p.text || p.inlineData || p.inline_data || p.fileData || p.file_data)) {
                            pendingToolResponseParts.push(p);
                        }
                    }
                }
                else {
                    const role = item.role === 'model' ? 'assistant' : item.role || 'user';
                    let content = '';
                    let reasoning_content = '';
                    if (role === 'assistant') {
                        const regularParts = (item.parts || []).filter((p) => !p.thought);
                        const thoughtParts = (item.parts || []).filter((p) => p.thought);
                        content = regularParts.map((p) => p.text || '').join('');
                        reasoning_content = thoughtParts.map((p) => p.text || '').join('');
                    }
                    else {
                        content = buildOpenAIUserContent(item.parts || []);
                    }
                    const msg = { role, content };
                    if (reasoning_content)
                        msg.reasoning_content = reasoning_content;
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
        if (messages[i].role === 'assistant')
            lastAssistantIdx = i;
    }
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && !messages[i].reasoning_content) {
            const preservedReasoning = shared_1.modelReasoningContent.get(stateKey) || '';
            if (i === lastAssistantIdx && preservedReasoning) {
                messages[i].reasoning_content = preservedReasoning;
            }
            else {
                delete messages[i].reasoning_content;
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
    const payload = {
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
        if (openaiTools.length > 0)
            payload.tools = openaiTools;
    }
    return payload;
}
// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────
// Проверяет, начался ли в потоке DSML-блок (ASCII `|` или полноширинная `｜` U+FF5C), который ещё не завершён.
function hasPendingDSMLMarker(text) {
    return /<(?:｜)?DSML(?:[|｜]|$)/.test(text) || /<(?:｜(?:D(?:S(?:M(?:L)?)?)?)?|D(?:S(?:M)?)?)$/.test(text);
}
function parseDSMLToolCalls(text) {
    try {
        const invokeRegex = /<(?:｜)?DSML[|｜]invoke name="([^"]+)">([\s\S]*?)<\/(?:｜)?DSML[|｜]invoke>/g;
        const functionCalls = [];
        let invokeMatch;
        while ((invokeMatch = invokeRegex.exec(text)) !== null) {
            const funcName = invokeMatch[1];
            const paramsBlock = invokeMatch[2];
            const args = {};
            const paramRegex = /<(?:｜)?DSML[|｜]parameter name="([^"]+)"(?: string="([^"]+)")?>([\s\S]*?)<\/(?:｜)?DSML[|｜]parameter>/g;
            let paramMatch;
            while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
                const paramName = paramMatch[1];
                let paramValue = paramMatch[3].trim();
                const isString = paramMatch[2] === 'true';
                if (!isString) {
                    try {
                        paramValue = JSON.parse(paramValue);
                    }
                    catch (e) {
                        electron_log_1.default.debug('[OpenAI] DSML param parse fallback:', e.message); /* keep as string */
                    }
                }
                args[paramName] = paramValue;
            }
            functionCalls.push({ name: funcName, args });
        }
        if (functionCalls.length === 0)
            return null;
        electron_log_1.default.info(`[Proxy] Detected ${functionCalls.length} DSML tool call(s): ${functionCalls.map((f) => f.name).join(', ')}`);
        let cleanText = text;
        cleanText = cleanText.replace(/<(?:｜)?DSML[|｜](?:tool_calls|function_calls)>[\s\S]*?<\/(?:｜)?DSML[|｜](?:tool_calls|function_calls)>/g, '');
        cleanText = cleanText.replace(/<(?:｜)?DSML[|｜]invoke name="[^"]+">[\s\S]*?<\/(?:｜)?DSML[|｜]invoke>/g, '');
        cleanText = cleanText.trim();
        return { functionCalls, cleanText };
    }
    catch (e) {
        electron_log_1.default.error('[Proxy] Failed to parse DSML tool calls:', e);
        return null;
    }
}
function buildOpenAIUsageMetadata(usage) {
    const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens || 0);
    return {
        promptTokenCount: usage?.prompt_tokens || 0,
        candidatesTokenCount: usage?.completion_tokens || 0,
        totalTokenCount: usage?.total_tokens || 0,
        ...(cachedTokens > 0 ? { cachedContentTokenCount: cachedTokens } : {}),
    };
}
function mapOpenAIToGemini(openAiRes, modelName, toolSchemas) {
    const choice = openAiRes.choices?.[0];
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    if (reasoning)
        saveModelReasoning(modelName, reasoning);
    const usageMetadata = buildOpenAIUsageMetadata(openAiRes.usage);
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
        const parts = choice.message.tool_calls.map((tc) => buildGeminiToolCallPart(tc.function.name, tc.function.arguments, tc.id, modelName, toolSchemas));
        if (choice.message.content)
            parts.unshift({ text: choice.message.content });
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
            usageMetadata,
        };
    }
    const text = choice?.message?.content || '';
    const dsml = parseDSMLToolCalls(text);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map((fc) => buildGeminiToolCallPart(fc.name, fc.args, undefined, modelName, toolSchemas));
        if (dsml.cleanText)
            parts.unshift({ text: dsml.cleanText });
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        return {
            candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
            usageMetadata,
        };
    }
    const parts = [];
    if (reasoning)
        parts.push({ text: reasoning, thought: true });
    if (text)
        parts.push({ text });
    const finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
    return {
        candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
        usageMetadata,
    };
}
// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────
function mapOpenAIChunkToGemini(chunk, modelName, streamKey, toolSchemas) {
    const choice = chunk.choices?.[0];
    if (!choice)
        return null;
    const delta = choice.delta;
    const streamId = streamKey || chunk.id || 'default_stream';
    if (!shared_1.activeStreamContexts.has(streamId)) {
        shared_1.activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.streamCtx, streamId);
    }
    const context = shared_1.activeStreamContexts.get(streamId);
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!context.toolCalls[idx])
                context.toolCalls[idx] = { id: '', name: '', arguments: '' };
            if (tc.id)
                context.toolCalls[idx].id = tc.id;
            if (tc.function?.name)
                context.toolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments)
                context.toolCalls[idx].arguments += tc.function.arguments;
        }
    }
    const text = delta?.content || '';
    const reasoning = delta?.reasoning_content || delta?.reasoning || '';
    if (reasoning)
        context.accumulatedReasoning += reasoning;
    if (text)
        context.accumulatedText += text;
    const dsml = parseDSMLToolCalls(context.accumulatedText);
    if (dsml && dsml.functionCalls.length > 0) {
        const parts = dsml.functionCalls.map((fc) => buildGeminiToolCallPart(fc.name, fc.args, undefined, modelName, toolSchemas));
        if (dsml.cleanText)
            parts.unshift({ text: dsml.cleanText });
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        context.accumulatedText = '';
        if (choice.finish_reason) {
            saveModelReasoning(modelName, context.accumulatedReasoning);
            shared_1.activeStreamContexts.delete(streamId);
        }
        return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
    }
    const finishReason = choice.finish_reason;
    if (finishReason === 'stop' || finishReason === 'length') {
        saveModelReasoning(modelName, context.accumulatedReasoning);
        const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => Boolean(tc.name));
        if (pendingToolCalls.length > 0) {
            const parts = pendingToolCalls.map((tc) => buildGeminiToolCallPart(tc.name, tc.arguments, tc.id, modelName, toolSchemas));
            if (reasoning)
                parts.unshift({ text: reasoning, thought: true });
            shared_1.activeStreamContexts.delete(streamId);
            return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
        }
        const remainingText = context.accumulatedText;
        context.accumulatedText = '';
        shared_1.activeStreamContexts.delete(streamId);
        const parts = [];
        if (reasoning)
            parts.push({ text: reasoning, thought: true });
        if (remainingText)
            parts.push({ text: remainingText });
        return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    if (finishReason === 'tool_calls') {
        saveModelReasoning(modelName, context.accumulatedReasoning);
        const parts = Object.values(context.toolCalls).map((tc) => buildGeminiToolCallPart(tc.name, tc.arguments, tc.id, modelName, toolSchemas));
        if (reasoning)
            parts.unshift({ text: reasoning, thought: true });
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
    }
    const streamParts = [];
    if (reasoning)
        streamParts.push({ text: reasoning, thought: true });
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
//# sourceMappingURL=openai.js.map