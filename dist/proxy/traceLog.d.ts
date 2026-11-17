/**
 * Суточное трассировочное логирование запросов и ответов прокси в формате JSONL.
 * Хранит полные тексты, мысли, вызовы инструментов и диагностику без обрезки,
 * убирая повторную запись неизменного префикса истории/инструментов в наглядном виде
 * и сжимая завершённые суточные файлы через zstd.
 */
export declare const TRACE_RETENTION_MS: number;
export interface TraceWriteOptions {
    dir?: string;
    now?: number;
    retentionMs?: number;
    sanitizePayload?: boolean;
}
/** Ожидает завершения всех поставленных в очередь операций записи и сжатия trace-логов. */
export declare function flushTraceWrites(): Promise<void>;
/** Сбрасывает кэш снимков диалогов и каталогов (преимущественно для тестов). */
export declare function resetTraceLogState(): void;
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
/** Сжимает завершённый файл трассировки в `.jsonl.zst` потоково с длинным окном и сохранением `mtime`. */
export declare function compressTraceFileToZstd(filePath: string): Promise<string | null>;
/**
 * Сжимает в zstd завершённые прошлые суточные `trace-*.jsonl` и удаляет файлы старше retentionMs,
 * не трогая сегодняшний активный файл.
 */
export declare function cleanupExpiredTraces(options?: TraceWriteOptions): Promise<number>;
/** Запускает периодическую фоновую очистку и сжатие trace-логов (раз в час, не удерживает процесс). */
export declare function startTraceCleanup(options?: TraceWriteOptions): void;
export declare function stopTraceCleanup(): void;
/** Асинхронно и последовательно дописывает событие трассировки в суточный JSONL-файл. */
export declare function writeTraceEvent(event: Record<string, unknown>, options?: TraceWriteOptions): void;
//# sourceMappingURL=traceLog.d.ts.map