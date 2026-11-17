/**
 * Общие вспомогательные функции для трансляторов протоколов.
 */
export interface GeminiParameterProperties {
    type?: string;
    properties?: GeminiParameterProperties;
    items?: GeminiParameterProperties;
    [key: string]: unknown;
}
export interface ToolCallArgs {
    CommandLine?: string;
    Cwd?: string;
    [key: string]: unknown;
}
export interface TranslatedToolCall {
    name: string;
    args: Record<string, unknown>;
}
export interface TranslatedCallInfo {
    originalName: string;
    translatedName: string;
    cmd: string;
    cwd?: string;
}
export interface MatchResult {
    Filename: string;
    LineNumber: number;
    LineContent: string;
}
export interface DirectoryItem {
    name: string;
    isDir: boolean;
    sizeBytes?: number;
}
export interface FileListResponse {
    files?: DirectoryItem[];
    children?: DirectoryItem[];
    content?: string;
    CodeContent?: string;
}
export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;
/** Tool declarations belong to one request, never to a shared model/session cache. */
export type ToolSchemas = ReadonlyMap<string, unknown>;
export declare function collectToolSchemas(body: unknown): ToolSchemas;
/**
 * Resolve explicit legacy aliases only. Live declarations take precedence over
 * historical tool signatures; arbitrary values must never become file paths.
 */
export declare function normalizeToolArgs(name: string, args: Record<string, unknown> | null | undefined, schemas?: ToolSchemas): Record<string, unknown>;
/**
 * Рекурсивно нормализует узел JSON Schema: переводит типы Gemini в нижний регистр
 * и преобразует числовые ограничения из строк Protobuf (например "1" в minLength) в числа.
 */
export declare function normalizeJsonSchemaNode(schema: Record<string, unknown>, visited?: Set<object>): void;
/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export declare function fixParamTypes(properties: Record<string, unknown> | undefined): void;
/**
 * Извлекает декларации инструментов из Gemini tools в нормализованном виде
 * (с однократным копированием схемы и нормализацией типов и числовых ограничений).
 */
export declare function extractGeminiToolDeclarations(geminiTools: unknown): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}>;
/**
 * Безопасно разбирает аргументы вызова инструмента из JSON-строки или объекта.
 */
export declare function parseToolCallArgs(rawArgs: unknown): ToolCallArgs;
/**
 * Сохраняет оригинальное имя и параметры вызова инструмента без подмены.
 * Команды терминала (включая ls, cat, grep и т.д.) передаются в run_command как есть.
 */
export declare function translateToolCallToNative(name: string, args: ToolCallArgs, _schemas?: ToolSchemas): TranslatedToolCall;
/**
 * Преобразует ответ инструмента в строку для передачи модели без искажения структуры.
 */
export declare function formatTranslatedResponse(_translatedInfo: TranslatedCallInfo, responseData: unknown): string;
//# sourceMappingURL=utils.d.ts.map