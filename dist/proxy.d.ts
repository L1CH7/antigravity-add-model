/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
 */
export interface CustomModel {
    name: string;
    displayName: string;
    description: string;
    provider: string;
    apiKey: string;
    apiUrl: string;
    externalModelName: string;
    allowUnauthorized?: boolean;
    encrypted?: boolean;
    _slug?: string;
    timeout?: number;
    maxRetries?: number;
    enabled?: boolean;
    apiFormat?: import('./providers').ApiFormat;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    reasoningEfforts?: Array<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
    defaultReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    thinkingBudget?: number;
    maxOutputTokens?: number;
    contextWindow?: number;
    idleTimeout?: number;
    retryBudgetMs?: number;
    circuitBreaker?: import('./proxy/circuitBreaker').CircuitBreakerOptions;
    customHeaders?: Record<string, string>;
    encryptedHeaders?: boolean;
    extraBody?: Record<string, unknown>;
    rawUrl?: boolean;
    gateway?: boolean;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    googleProject?: string;
    googleAccounts?: import('./googleAccounts').GoogleAccount[];
    googlePool?: import('./googleAccounts').GooglePoolOptions;
    encryptedGoogleAccounts?: boolean;
}
export { NATIVE_GOOGLE_MODELS, isNativeGoogleModelName } from './proxy/modelUtils';
export declare function generateModelPlaceholderId(model: CustomModel): string;
export declare function toSlug(model: CustomModel): string;
interface ResolvedCustomModel {
    model: CustomModel;
    slug: string;
    placeholderId: string;
}
export declare function collectOccupiedPlaceholders(payload: Record<string, unknown> | null | undefined): Set<string>;
export declare function resolveCustomModelKeys(models: CustomModel[], occupiedPlaceholders?: ReadonlySet<string>): ResolvedCustomModel[];
export declare function mergeFetchAvailableModelsResponse(googleJson: Record<string, unknown> | null, customModels: CustomModel[]): Record<string, unknown>;
export declare function mergeListModelsResponse(googleJson: Record<string, unknown> | null, customModels: CustomModel[]): Record<string, unknown>;
export declare function findMatchedCustomModel(customModels: CustomModel[], modelName?: string, modelId?: string): CustomModel | undefined;
export declare function startProxy(): Promise<number>;
export declare function stopProxy(): Promise<void>;
export declare function getProxyPort(): number;
//# sourceMappingURL=proxy.d.ts.map