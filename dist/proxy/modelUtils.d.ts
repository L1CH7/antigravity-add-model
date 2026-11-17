/**
 * Глобальные дефолты и чтение возможностей модели строго из конфигурации,
 * без эвристик и угадывания по имени модели.
 */
export declare const DEFAULT_CONTEXT_WINDOW = 1048576;
export declare const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
export interface CustomModelConfig {
    name: string;
    provider: string;
    externalModelName?: string;
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
}
export interface ModelCapabilities {
    isThinking: boolean;
    maxTokens: number;
    maxOutputTokens: number;
    supportsImages: boolean;
}
export interface ModelNameCapabilities {
    isClaudeThinkingModel: boolean;
    isThinkingModel: boolean;
}
/**
 * Возвращает возможности модели из её конфигурации с глобальными дефолтами.
 */
export declare function detectModelCapabilities(m: CustomModelConfig, _includeDisplayName?: boolean): ModelCapabilities;
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
export declare function detectModelCapabilitiesByName(modelName: string): ModelNameCapabilities;
export declare const NATIVE_GOOGLE_MODELS: {
    name: string;
    displayName: string;
}[];
export declare function isNativeGoogleModelName(name?: string): boolean;
//# sourceMappingURL=modelUtils.d.ts.map