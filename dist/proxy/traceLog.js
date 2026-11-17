"use strict";
/**
 * Суточное трассировочное логирование запросов и ответов прокси в формате JSONL.
 * Хранит полные тексты, мысли, вызовы инструментов и диагностику без обрезки,
 * убирая повторную запись неизменного префикса истории/инструментов в наглядном виде
 * и сжимая завершённые суточные файлы через zstd.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRACE_RETENTION_MS = void 0;
exports.flushTraceWrites = flushTraceWrites;
exports.resetTraceLogState = resetTraceLogState;
exports.resolveTraceDir = resolveTraceDir;
exports.maskSecretValue = maskSecretValue;
exports.sanitizeTraceHeaders = sanitizeTraceHeaders;
exports.sanitizeTracePayload = sanitizeTracePayload;
exports.formatTraceDate = formatTraceDate;
exports.getTraceFilePath = getTraceFilePath;
exports.compressTraceFileToZstd = compressTraceFileToZstd;
exports.cleanupExpiredTraces = cleanupExpiredTraces;
exports.startTraceCleanup = startTraceCleanup;
exports.stopTraceCleanup = stopTraceCleanup;
exports.writeTraceEvent = writeTraceEvent;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const zlib = __importStar(require("zlib"));
const promises_1 = require("stream/promises");
const crypto_1 = require("crypto");
exports.TRACE_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TRACE_FILE_PATTERN = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl(\.zst)?$/;
const BASE64_OMIT_THRESHOLD = 256;
const MAX_CONVO_SNAPSHOTS = 128;
const SENSITIVE_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'cookie',
    'set-cookie',
]);
let cleanupTimer = null;
let lastCleanupAt = 0;
let writeQueue = Promise.resolve();
const ensuredDirs = new Set();
const convoSnapshots = new Map();
function enqueueTraceTask(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.then(() => undefined, () => undefined);
    return next;
}
/** Ожидает завершения всех поставленных в очередь операций записи и сжатия trace-логов. */
function flushTraceWrites() {
    return writeQueue;
}
/** Сбрасывает кэш снимков диалогов и каталогов (преимущественно для тестов). */
function resetTraceLogState() {
    convoSnapshots.clear();
    ensuredDirs.clear();
}
async function ensureTraceDir(dir) {
    if (ensuredDirs.has(dir))
        return;
    await fs.promises.mkdir(dir, { recursive: true });
    ensuredDirs.add(dir);
}
/** Определяет каталог для trace-логов; в тестовом окружении Vitest отключает запись без явного dir. */
function resolveTraceDir(explicitDir) {
    if (explicitDir)
        return explicitDir;
    if (process.env.VITEST || process.env.NODE_ENV === 'test')
        return null;
    let baseLogsDir;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron');
        baseLogsDir = electron?.app?.getPath?.('logs');
    }
    catch {
        baseLogsDir = undefined;
    }
    return baseLogsDir
        ? path.join(baseLogsDir, 'trace')
        : path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'trace');
}
/** Маскирует середину секрета, сохраняя префикс схемы (например Bearer) и крайние символы для идентификации. */
function maskSecretValue(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed)
        return '';
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx > 0 && spaceIdx < 16) {
        const scheme = trimmed.slice(0, spaceIdx);
        const token = trimmed.slice(spaceIdx + 1).trim();
        if (token)
            return `${scheme} ${maskRawToken(token)}`;
    }
    return maskRawToken(trimmed);
}
function maskRawToken(token) {
    if (token.length < 6)
        return '***';
    if (token.length < 12)
        return `${token.slice(0, 2)}...${token.slice(-2)}`;
    return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
/** Возвращает копию заголовков с замаскированной серединой секретных ключей. */
function sanitizeTraceHeaders(headers) {
    const sanitized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined)
            continue;
        sanitized[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? maskSecretValue(value) : value;
    }
    return sanitized;
}
function summarizeBase64(b64, mime = 'binary') {
    const hash = (0, crypto_1.createHash)('sha256').update(b64).digest('hex').slice(0, 12);
    return `<base64:${mime}, ${b64.length} chars, sha256=${hash}>`;
}
/** Сохраняет все тексты и JSON-структуры целиком, заменяя только длинные base64-данные на компактную метку. */
function sanitizeTracePayload(value) {
    if (typeof value === 'string') {
        if (value.length > BASE64_OMIT_THRESHOLD && value.startsWith('data:')) {
            const match = /^data:([^;]*);base64,(.*)$/is.exec(value);
            if (match && match[2].length > BASE64_OMIT_THRESHOLD) {
                return `data:${match[1] || 'application/octet-stream'};base64,${summarizeBase64(match[2], match[1] || 'binary')}`;
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeTracePayload(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const obj = value;
    const out = {};
    const inlineMime = (typeof obj.mimeType === 'string' && obj.mimeType) ||
        (typeof obj.mime_type === 'string' && obj.mime_type) ||
        undefined;
    for (const [k, v] of Object.entries(obj)) {
        if (k === 'data' && inlineMime && typeof v === 'string' && v.length > BASE64_OMIT_THRESHOLD) {
            out[k] = summarizeBase64(v, inlineMime);
        }
        else {
            out[k] = sanitizeTracePayload(v);
        }
    }
    return out;
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
function setConvoSnapshot(key, snap) {
    if (convoSnapshots.has(key))
        convoSnapshots.delete(key);
    convoSnapshots.set(key, snap);
    while (convoSnapshots.size > MAX_CONVO_SNAPSHOTS) {
        const oldestKey = convoSnapshots.keys().next().value;
        if (oldestKey === undefined)
            break;
        convoSnapshots.delete(oldestKey);
    }
}
/**
 * Убирает повторное дублирование неизменных инструкций, инструментов и совпавшего префикса
 * сообщений внутри одного файла и диалога, заменяя их наглядными ссылками на запрос-источник.
 * Не мутирует исходный объект запроса.
 */
function compactAndSanitizeRequestPayload(payload, filePath, conversationKey, requestId, shouldSanitize) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return shouldSanitize ? sanitizeTracePayload(payload) : payload;
    }
    const rawPayload = payload;
    const targetObj = rawPayload.request && typeof rawPayload.request === 'object' && !Array.isArray(rawPayload.request)
        ? rawPayload.request
        : rawPayload;
    const isWrapped = targetObj !== rawPayload;
    const snapKey = `${filePath}::${conversationKey}`;
    const prev = convoSnapshots.get(snapKey);
    const nextSnap = { requestId };
    const compactedTarget = {};
    for (const [key, val] of Object.entries(targetObj)) {
        if (key === 'tools' && Array.isArray(val)) {
            const toolsRaw = safeJsonStringify(val);
            if (toolsRaw !== undefined) {
                if (prev?.toolsRaw === toolsRaw && prev.toolsAnchorId) {
                    nextSnap.toolsRaw = toolsRaw;
                    nextSnap.toolsAnchorId = prev.toolsAnchorId;
                    compactedTarget[key] = `[без изменений — как в req ${prev.toolsAnchorId} (${val.length} шт.)]`;
                    continue;
                }
                nextSnap.toolsRaw = toolsRaw;
                nextSnap.toolsAnchorId = requestId;
            }
            compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
            continue;
        }
        if ((key === 'system' || key === 'systemInstruction') && val !== undefined) {
            const sysRaw = safeJsonStringify(val);
            if (sysRaw !== undefined) {
                if (prev?.systemRaw === sysRaw && prev.systemAnchorId) {
                    nextSnap.systemRaw = sysRaw;
                    nextSnap.systemAnchorId = prev.systemAnchorId;
                    compactedTarget[key] = `[без изменений — как в req ${prev.systemAnchorId} (${sysRaw.length} симв.)]`;
                    continue;
                }
                nextSnap.systemRaw = sysRaw;
                nextSnap.systemAnchorId = requestId;
            }
            compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
            continue;
        }
        if ((key === 'messages' || key === 'contents') && Array.isArray(val)) {
            const itemLabel = key === 'contents' ? 'элемент(ов)' : 'сообщ.';
            const itemsRaw = val.map((item) => safeJsonStringify(item) ?? '');
            nextSnap.itemsRaw = itemsRaw;
            nextSnap.itemsAnchorId = requestId;
            let prefixLen = 0;
            if (prev?.itemsRaw && prev.itemsAnchorId) {
                const limit = Math.min(prev.itemsRaw.length, itemsRaw.length);
                while (prefixLen < limit && prev.itemsRaw[prefixLen] && prev.itemsRaw[prefixLen] === itemsRaw[prefixLen]) {
                    prefixLen += 1;
                }
            }
            if (prefixLen >= 1 && prev?.itemsAnchorId) {
                const tail = val.slice(prefixLen);
                const sanitizedTail = shouldSanitize ? sanitizeTracePayload(tail) : tail;
                compactedTarget[key] = [
                    { _reusedPrefix: `первые ${prefixLen} ${itemLabel} без изменений — см. req ${prev.itemsAnchorId}` },
                    ...sanitizedTail,
                ];
            }
            else {
                compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
            }
            continue;
        }
        compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
    }
    setConvoSnapshot(snapKey, nextSnap);
    if (!isWrapped)
        return compactedTarget;
    const compactedEnvelope = {};
    for (const [k, v] of Object.entries(rawPayload)) {
        if (k === 'request')
            compactedEnvelope[k] = compactedTarget;
        else
            compactedEnvelope[k] = shouldSanitize ? sanitizeTracePayload(v) : v;
    }
    return compactedEnvelope;
}
function formatTraceDate(now = Date.now()) {
    const d = new Date(now);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function getTraceFilePath(dir, now = Date.now()) {
    return path.join(dir, `trace-${formatTraceDate(now)}.jsonl`);
}
/** Сжимает завершённый файл трассировки в `.jsonl.zst` потоково с длинным окном и сохранением `mtime`. */
async function compressTraceFileToZstd(filePath) {
    const zstdFactory = zlib.createZstdCompress;
    if (typeof zstdFactory !== 'function')
        return null;
    const targetPath = `${filePath}.zst`;
    const tmpPath = `${targetPath}.tmp`;
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile())
            return null;
        const zstdConsts = zlib.constants || {};
        const params = {};
        if (typeof zstdConsts.ZSTD_c_compressionLevel === 'number') {
            params[zstdConsts.ZSTD_c_compressionLevel] = 6;
        }
        if (typeof zstdConsts.ZSTD_c_windowLog === 'number') {
            params[zstdConsts.ZSTD_c_windowLog] = 25;
        }
        const compressor = zstdFactory(Object.keys(params).length > 0 ? { params } : undefined);
        await (0, promises_1.pipeline)(fs.createReadStream(filePath), compressor, fs.createWriteStream(tmpPath));
        await fs.promises.utimes(tmpPath, stat.atime, stat.mtime);
        await fs.promises.rename(tmpPath, targetPath);
        await fs.promises.unlink(filePath);
        return targetPath;
    }
    catch {
        try {
            await fs.promises.unlink(tmpPath);
        }
        catch {
            // Игнорируем ошибку очистки временного файла.
        }
        return null;
    }
}
/**
 * Сжимает в zstd завершённые прошлые суточные `trace-*.jsonl` и удаляет файлы старше retentionMs,
 * не трогая сегодняшний активный файл.
 */
async function cleanupExpiredTraces(options) {
    const dir = resolveTraceDir(options?.dir);
    if (!dir)
        return 0;
    const now = options?.now ?? Date.now();
    const retentionMs = options?.retentionMs ?? exports.TRACE_RETENTION_MS;
    const todayFile = `trace-${formatTraceDate(now)}.jsonl`;
    let removed = 0;
    try {
        const entries = await fs.promises.readdir(dir);
        for (const name of entries) {
            if (!TRACE_FILE_PATTERN.test(name) || name === todayFile)
                continue;
            const fullPath = path.join(dir, name);
            try {
                const stat = await fs.promises.stat(fullPath);
                if (!stat.isFile())
                    continue;
                if (now - stat.mtimeMs > retentionMs) {
                    await enqueueTraceTask(() => fs.promises.unlink(fullPath));
                    removed += 1;
                }
                else if (!name.endsWith('.zst')) {
                    await enqueueTraceTask(() => compressTraceFileToZstd(fullPath));
                }
            }
            catch {
                // Игнорируем гонку удаления или временную блокировку файла.
            }
        }
    }
    catch {
        // Каталог логов может ещё не существовать до первой записи.
    }
    return removed;
}
/** Запускает периодическую фоновую очистку и сжатие trace-логов (раз в час, не удерживает процесс). */
function startTraceCleanup(options) {
    if (cleanupTimer)
        return;
    lastCleanupAt = Date.now();
    void cleanupExpiredTraces(options);
    cleanupTimer = setInterval(() => {
        lastCleanupAt = Date.now();
        void cleanupExpiredTraces(options);
    }, TRACE_CLEANUP_INTERVAL_MS);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }
}
function stopTraceCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}
/** Асинхронно и последовательно дописывает событие трассировки в суточный JSONL-файл. */
function writeTraceEvent(event, options) {
    const dir = resolveTraceDir(options?.dir);
    if (!dir)
        return;
    const now = options?.now ?? Date.now();
    const filePath = getTraceFilePath(dir, now);
    let record = { ts: new Date(now).toISOString(), ...event };
    if (record.phase === 'request' &&
        'payload' in record &&
        typeof record.conversationKey === 'string' &&
        typeof record.requestId === 'string') {
        record = {
            ...record,
            payload: compactAndSanitizeRequestPayload(record.payload, filePath, record.conversationKey, record.requestId, options?.sanitizePayload !== false),
        };
    }
    else if (options?.sanitizePayload && 'payload' in record) {
        record = { ...record, payload: sanitizeTracePayload(record.payload) };
    }
    let line;
    try {
        line = JSON.stringify(record) + '\n';
    }
    catch {
        return;
    }
    if (now - lastCleanupAt >= TRACE_CLEANUP_INTERVAL_MS) {
        lastCleanupAt = now;
        void cleanupExpiredTraces({ dir, now, retentionMs: options?.retentionMs });
    }
    void enqueueTraceTask(async () => {
        await ensureTraceDir(dir);
        await fs.promises.appendFile(filePath, line, 'utf8');
    });
}
//# sourceMappingURL=traceLog.js.map