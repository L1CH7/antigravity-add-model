"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_GOOGLE_MODELS = exports.TEXTUAL_APPLICATION_MIMES = exports.DEFAULT_MAX_OUTPUT_TOKENS = exports.DEFAULT_CONTEXT_WINDOW = void 0;
exports.isTextualInlineMime = isTextualInlineMime;
exports.detectModelCapabilities = detectModelCapabilities;
exports.detectModelCapabilitiesByName = detectModelCapabilitiesByName;
exports.isNativeGoogleModelName = isNativeGoogleModelName;
const providers_1 = require("../providers");
/**
 * Глобальные дефолты и чтение возможностей модели строго из конфигурации,
 * без эвристик и угадывания по имени модели.
 */
exports.DEFAULT_CONTEXT_WINDOW = 1048576;
exports.DEFAULT_MAX_OUTPUT_TOKENS = 65536;
exports.TEXTUAL_APPLICATION_MIMES = [
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/xhtml+xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
    'application/x-typescript',
    'application/x-python-code',
    'application/x-ipynb+json',
    'application/x-sh',
    'application/toml',
    'application/sql',
    'application/graphql',
];
const TEXTUAL_INLINE_MIME_SET = new Set([...exports.TEXTUAL_APPLICATION_MIMES, 'image/svg+xml']);
function isTextualInlineMime(rawMime) {
    const mime = (rawMime || '').split(';')[0].trim().toLowerCase();
    return mime.startsWith('text/') || TEXTUAL_INLINE_MIME_SET.has(mime);
}
// ─── Capabilities ─────────────────────────────────────────────────────────
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;
/**
 * Возвращает возможности модели из её конфигурации с глобальными дефолтами.
 */
function detectModelCapabilities(m, _includeDisplayName = true) {
    const isGoogleFormat = (0, providers_1.resolveApiFormat)(m.provider, m.apiFormat) === 'google';
    const hasReasoning = Boolean(m.reasoningEffort || (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0));
    const isThinking = m.supportsThinking ?? hasReasoning;
    const maxTokens = m.contextWindow ?? exports.DEFAULT_CONTEXT_WINDOW;
    const maxOutputTokens = m.maxOutputTokens ?? exports.DEFAULT_MAX_OUTPUT_TOKENS;
    const supportsImages = m.supportsVision ?? true;
    const supportsAudio = m.supportsAudio ?? true;
    const supportsVideo = m.supportsVideo ?? isGoogleFormat;
    return { isThinking, isGoogleFormat, maxTokens, maxOutputTokens, supportsImages, supportsAudio, supportsVideo };
}
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
function detectModelCapabilitiesByName(modelName) {
    const lower = (modelName || '').toLowerCase();
    return {
        isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
        isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
    };
}
exports.NATIVE_GOOGLE_MODELS = [
    { name: 'models/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash High' },
    { name: 'models/gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash Medium' },
    { name: 'models/gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash Low' },
    { name: 'models/gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash Tiered' },
    { name: 'models/gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash High' },
    { name: 'models/gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash Medium' },
    { name: 'models/gemini-3.7-flash-low', displayName: 'Gemini 3.7 Flash Low' },
    { name: 'models/gemini-3.7-flash-tiered', displayName: 'Gemini 3.7 Flash Tiered' },
    { name: 'models/gemini-3.5-pro', displayName: 'Gemini 3.5 Pro' },
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
    { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    { name: 'models/claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet' },
    { name: 'models/claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet' },
];
function isNativeGoogleModelName(name) {
    if (!name)
        return false;
    const clean = name.replace(/^models\//, '').trim();
    if (clean.startsWith('custom-') || clean.startsWith('MODEL_PLACEHOLDER_')) {
        return false;
    }
    return (clean.startsWith('gemini-') ||
        clean.startsWith('claude-') ||
        clean.startsWith('chat-') ||
        clean.startsWith('code-') ||
        clean.startsWith('text-') ||
        clean.startsWith('embedding-') ||
        clean === 'auto');
}
//# sourceMappingURL=modelUtils.js.map