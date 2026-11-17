/**
 * Суточное трассировочное логирование запросов и ответов прокси в формате JSONL.
 * Хранит полные тексты, мысли, вызовы инструментов и диагностику без обрезки,
 * маскируя лишь середину секретов в заголовках и заменяя длинные base64-блобы на метаданные.
 */
export declare const TRACE_RETENTION_MS: number;
export interface TraceWriteOptions {
    dir?: string;
    now?: number;
    retentionMs?: number;
}
/** Определяет каталог для trace-логов; в тестовом окружении Vitest отключает запись без явного dir. */
export declare function resolveTraceDir(explicitDir?: string): string | null;
/** Маскирует середину секрета, сохраняя префикс схемы (например Bearer) и крайние символы для идентификации. */
export declare function maskSecretValue(raw: string): string;
/** Возвращает копию заголовков с замаскированной серединой секретных ключей. */
export declare function sanitizeTraceHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined>;
/** Сохраняет все тексты и JSON-структуры целиком, заменяя только длинные base64-данные на компактную метку. */
export declare function sanitizeTracePayload(value: unknown): unknown;
export declare function formatTraceDate(now?: number): string;
export declare function getTraceFilePath(dir: string, now?: number): string;
/** Удаляет устаревшие trace-*.jsonl старше retentionMs (по умолчанию 24 ч), не трогая сегодняшний файл. */
export declare function cleanupExpiredTraces(options?: TraceWriteOptions): Promise<number>;
/** Запускает периодическую фоновую очистку trace-логов (раз в час, не удерживает процесс). */
export declare function startTraceCleanup(options?: TraceWriteOptions): void;
export declare function stopTraceCleanup(): void;
/** Асинхронно дописывает событие трассировки в суточный JSONL-файл и при необходимости запускает ротационную очистку. */
export declare function writeTraceEvent(event: Record<string, unknown>, options?: TraceWriteOptions): void;
//# sourceMappingURL=traceLog.d.ts.map