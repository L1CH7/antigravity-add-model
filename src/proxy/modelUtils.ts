import { ApiFormat, resolveApiFormat } from '../providers';

/**
 * Глобальные дефолты и чтение возможностей модели строго из конфигурации,
 * без эвристик и угадывания по имени модели.
 */

export const DEFAULT_CONTEXT_WINDOW = 1_048_576;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export const TEXTUAL_APPLICATION_MIMES = [
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
] as const;

const TEXTUAL_INLINE_MIME_SET = new Set<string>([...TEXTUAL_APPLICATION_MIMES, 'image/svg+xml']);

export function isTextualInlineMime(rawMime: string | undefined): boolean {
  const mime = (rawMime || '').split(';')[0].trim().toLowerCase();
  return mime.startsWith('text/') || TEXTUAL_INLINE_MIME_SET.has(mime);
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface CustomModelConfig {
  name: string;
  provider: string;
  apiFormat?: ApiFormat;
  externalModelName?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
}

export interface ModelCapabilities {
  isThinking: boolean;
  isGoogleFormat: boolean;
  maxTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
}

export interface ModelNameCapabilities {
  isClaudeThinkingModel: boolean;
  isThinkingModel: boolean;
}

// ─── Capabilities ─────────────────────────────────────────────────────────

const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;

/**
 * Возвращает возможности модели из её конфигурации с глобальными дефолтами.
 */
export function detectModelCapabilities(m: CustomModelConfig, _includeDisplayName = true): ModelCapabilities {
  const isGoogleFormat = resolveApiFormat(m.provider, m.apiFormat) === 'google';
  const hasReasoning = Boolean(m.reasoningEffort || (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0));
  const isThinking = m.supportsThinking ?? hasReasoning;
  const maxTokens = m.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const supportsImages = m.supportsVision ?? true;
  const supportsAudio = m.supportsAudio ?? true;
  const supportsVideo = m.supportsVideo ?? isGoogleFormat;

  return { isThinking, isGoogleFormat, maxTokens, maxOutputTokens, supportsImages, supportsAudio, supportsVideo };
}

/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities {
  const lower = (modelName || '').toLowerCase();
  return {
    isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
    isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
  };
}

export const NATIVE_GOOGLE_MODELS: { name: string; displayName: string }[] = [
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

export function isNativeGoogleModelName(name?: string): boolean {
  if (!name) return false;
  const clean = name.replace(/^models\//, '').trim();
  if (clean.startsWith('custom-') || clean.startsWith('MODEL_PLACEHOLDER_')) {
    return false;
  }
  return (
    clean.startsWith('gemini-') ||
    clean.startsWith('claude-') ||
    clean.startsWith('chat-') ||
    clean.startsWith('code-') ||
    clean.startsWith('text-') ||
    clean.startsWith('embedding-') ||
    clean === 'auto'
  );
}
