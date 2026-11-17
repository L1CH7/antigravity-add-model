"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trimContext = trimContext;
exports.applyRequestOptions = applyRequestOptions;
exports.parseRetryAfter = parseRetryAfter;
const openai_1 = require("./translators/openai");
/** Conservative estimate, not a tokenizer. Drop whole oldest turns, never half a tool exchange. */
function trimContext(body, contextWindow, maxOutputTokens = 0) {
    if (!contextWindow)
        return body;
    const budget = contextWindow - maxOutputTokens;
    const groups = [];
    for (const content of body.contents || []) {
        const startsTurn = content.role !== 'model' && !content.parts?.some((part) => part.functionResponse);
        if (!groups.length || startsTurn)
            groups.push([]);
        groups[groups.length - 1].push(content);
    }
    if (groups.length === 0) {
        const baseBytes = Buffer.byteLength(JSON.stringify({ ...body, contents: [] }), 'utf8');
        if (Math.ceil(baseBytes / 3) > budget)
            throw new Error('The latest turn, system instructions and tools exceed the configured contextWindow.');
        return { ...body, contents: [] };
    }
    // Побайтовый подсчёт за O(N) без повторной сериализации всего диалога на каждом шаге отсечения.
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...body, contents: [] }), 'utf8');
    const groupContentBytes = groups.map((group) => {
        let bytes = 0;
        for (const item of group) {
            bytes += Buffer.byteLength(JSON.stringify(item), 'utf8');
        }
        return { bytes, items: group.length };
    });
    let totalElementBytes = 0;
    let totalItems = 0;
    for (const g of groupContentBytes) {
        totalElementBytes += g.bytes;
        totalItems += g.items;
    }
    let startGroup = 0;
    while (startGroup < groups.length - 1) {
        const totalBytes = baseBytes + totalElementBytes + Math.max(0, totalItems - 1);
        if (Math.ceil(totalBytes / 3) <= budget)
            break;
        totalElementBytes -= groupContentBytes[startGroup].bytes;
        totalItems -= groupContentBytes[startGroup].items;
        startGroup += 1;
    }
    const finalBytes = baseBytes + totalElementBytes + Math.max(0, totalItems - 1);
    if (Math.ceil(finalBytes / 3) > budget)
        throw new Error('The latest turn, system instructions and tools exceed the configured contextWindow.');
    const keptContents = startGroup === 0 ? groups.flat() : groups.slice(startGroup).flat();
    return { ...body, contents: keptContents };
}
function applyRequestOptions(payload, model, format, stream) {
    const result = { ...payload };
    const reserved = new Set(['model', 'messages', 'contents', 'system', 'systemInstruction', 'tools', 'stream']);
    for (const [key, value] of Object.entries(model.extraBody || {})) {
        if (reserved.has(key))
            throw new Error(`extraBody cannot override ${key}`);
        result[key] = value;
    }
    if (format === 'google') {
        delete result.stream;
        const generation = { ...(result.generationConfig || {}) };
        if (model.maxOutputTokens !== undefined)
            generation.maxOutputTokens = model.maxOutputTokens;
        if (model.thinkingBudget !== undefined)
            generation.thinkingConfig = { thinkingBudget: model.thinkingBudget };
        result.generationConfig = generation;
    }
    else {
        result.stream = stream;
        if (model.maxOutputTokens !== undefined) {
            const targetModelName = model.externalModelName || model.name || '';
            if (format === 'openai' && (result.max_completion_tokens !== undefined || (0, openai_1.usesMaxCompletionTokens)(targetModelName)))
                result.max_completion_tokens = model.maxOutputTokens;
            else
                result.max_tokens = model.maxOutputTokens;
        }
        if (format === 'openai' && model.reasoningEffort !== undefined)
            result.reasoning_effort = model.reasoningEffort;
        if (format === 'openai') {
            if (stream && result.stream_options === undefined) {
                result.stream_options = { include_usage: true };
            }
            else if (result.stream_options === null) {
                delete result.stream_options;
            }
        }
        if (format === 'anthropic' && model.thinkingBudget !== undefined) {
            if (model.thinkingBudget === 0)
                result.thinking = { type: 'disabled' };
            else {
                if (model.thinkingBudget < 1024 || model.thinkingBudget >= Number(result.max_tokens)) {
                    throw new Error('Anthropic thinkingBudget must be at least 1024 and smaller than maxOutputTokens.');
                }
                result.thinking = { type: 'enabled', budget_tokens: model.thinkingBudget };
                delete result.temperature;
            }
        }
    }
    return result;
}
function parseRetryAfter(value, now = Date.now()) {
    const raw = (Array.isArray(value) ? value[0] : value)?.trim();
    if (!raw)
        return 0;
    const delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 30000)) : 0;
}
//# sourceMappingURL=requestOptions.js.map