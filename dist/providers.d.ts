/** Shared provider presets. Existing saved models retain their historical wire format. */
export type ApiFormat = 'openai' | 'anthropic' | 'google';
export interface ProviderPreset {
    id: string;
    label: string;
    defaultUrl: string;
    apiFormat: ApiFormat;
    keyRequired: boolean;
}
export declare const PROVIDERS: readonly ProviderPreset[];
export declare function getProvider(id: string): ProviderPreset | undefined;
/** Берёт формат протокола из явного apiFormat модели или таблицы PROVIDERS без legacy-подмен. */
export declare function resolveApiFormat(provider: string, override?: ApiFormat): ApiFormat;
//# sourceMappingURL=providers.d.ts.map