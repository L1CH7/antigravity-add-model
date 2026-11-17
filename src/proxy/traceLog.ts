/**
 * Суточное трассировочное логирование запросов и ответов прокси в формате JSONL.
 * Хранит полные тексты, мысли, вызовы инструментов и диагностику без обрезки,
 * убирая повторную запись неизменного префикса истории/инструментов в наглядном виде
 * и сжимая завершённые суточные файлы через zstd.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

export const TRACE_RETENTION_MS = 24 * 60 * 60 * 1000;
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

export interface TraceWriteOptions {
  dir?: string;
  now?: number;
  retentionMs?: number;
  sanitizePayload?: boolean;
}

interface ConversationTraceSnapshot {
  requestId: string;
  toolsAnchorId?: string;
  toolsRaw?: string;
  systemAnchorId?: string;
  systemRaw?: string;
  itemsAnchorId?: string;
  itemsRaw?: string[];
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastCleanupAt = 0;
let writeQueue: Promise<void> = Promise.resolve();
const ensuredDirs = new Set<string>();
const convoSnapshots = new Map<string, ConversationTraceSnapshot>();

function enqueueTraceTask<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Ожидает завершения всех поставленных в очередь операций записи и сжатия trace-логов. */
export function flushTraceWrites(): Promise<void> {
  return writeQueue;
}

/** Сбрасывает кэш снимков диалогов и каталогов (преимущественно для тестов). */
export function resetTraceLogState(): void {
  convoSnapshots.clear();
  ensuredDirs.clear();
}

async function ensureTraceDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) return;
  await fs.promises.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/** Определяет каталог для trace-логов; в тестовом окружении Vitest отключает запись без явного dir. */
export function resolveTraceDir(explicitDir?: string): string | null {
  if (explicitDir) return explicitDir;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return null;

  let baseLogsDir: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } };
    baseLogsDir = electron?.app?.getPath?.('logs');
  } catch {
    baseLogsDir = undefined;
  }

  return baseLogsDir
    ? path.join(baseLogsDir, 'trace')
    : path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'trace');
}

/** Маскирует середину секрета, сохраняя префикс схемы (например Bearer) и крайние символы для идентификации. */
export function maskSecretValue(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < 16) {
    const scheme = trimmed.slice(0, spaceIdx);
    const token = trimmed.slice(spaceIdx + 1).trim();
    if (token) return `${scheme} ${maskRawToken(token)}`;
  }
  return maskRawToken(trimmed);
}

function maskRawToken(token: string): string {
  if (token.length < 6) return '***';
  if (token.length < 12) return `${token.slice(0, 2)}...${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/** Возвращает копию заголовков с замаскированной серединой секретных ключей. */
export function sanitizeTraceHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    sanitized[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? maskSecretValue(value) : value;
  }
  return sanitized;
}

function summarizeBase64(b64: string, mime = 'binary'): string {
  const hash = createHash('sha256').update(b64).digest('hex').slice(0, 12);
  return `<base64:${mime}, ${b64.length} chars, sha256=${hash}>`;
}

/** Сохраняет все тексты и JSON-структуры целиком, заменяя только длинные base64-данные на компактную метку. */
export function sanitizeTracePayload(value: unknown): unknown {
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

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const inlineMime =
    (typeof obj.mimeType === 'string' && obj.mimeType) ||
    (typeof obj.mime_type === 'string' && obj.mime_type) ||
    undefined;

  for (const [k, v] of Object.entries(obj)) {
    if (k === 'data' && inlineMime && typeof v === 'string' && v.length > BASE64_OMIT_THRESHOLD) {
      out[k] = summarizeBase64(v, inlineMime);
    } else {
      out[k] = sanitizeTracePayload(v);
    }
  }
  return out;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setConvoSnapshot(key: string, snap: ConversationTraceSnapshot): void {
  if (convoSnapshots.has(key)) convoSnapshots.delete(key);
  convoSnapshots.set(key, snap);
  while (convoSnapshots.size > MAX_CONVO_SNAPSHOTS) {
    const oldestKey = convoSnapshots.keys().next().value;
    if (oldestKey === undefined) break;
    convoSnapshots.delete(oldestKey);
  }
}

/**
 * Убирает повторное дублирование неизменных инструкций, инструментов и совпавшего префикса
 * сообщений внутри одного файла и диалога, заменяя их наглядными ссылками на запрос-источник.
 * Не мутирует исходный объект запроса.
 */
function compactAndSanitizeRequestPayload(
  payload: unknown,
  filePath: string,
  conversationKey: string,
  requestId: string,
  shouldSanitize: boolean,
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return shouldSanitize ? sanitizeTracePayload(payload) : payload;
  }

  const rawPayload = payload as Record<string, unknown>;
  const targetObj =
    rawPayload.request && typeof rawPayload.request === 'object' && !Array.isArray(rawPayload.request)
      ? (rawPayload.request as Record<string, unknown>)
      : rawPayload;
  const isWrapped = targetObj !== rawPayload;

  const snapKey = `${filePath}::${conversationKey}`;
  const prev = convoSnapshots.get(snapKey);
  const nextSnap: ConversationTraceSnapshot = { requestId };
  const compactedTarget: Record<string, unknown> = {};

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
        const sanitizedTail = shouldSanitize ? (sanitizeTracePayload(tail) as unknown[]) : tail;
        compactedTarget[key] = [
          { _reusedPrefix: `первые ${prefixLen} ${itemLabel} без изменений — см. req ${prev.itemsAnchorId}` },
          ...sanitizedTail,
        ];
      } else {
        compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
      }
      continue;
    }

    compactedTarget[key] = shouldSanitize ? sanitizeTracePayload(val) : val;
  }

  setConvoSnapshot(snapKey, nextSnap);

  if (!isWrapped) return compactedTarget;

  const compactedEnvelope: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawPayload)) {
    if (k === 'request') compactedEnvelope[k] = compactedTarget;
    else compactedEnvelope[k] = shouldSanitize ? sanitizeTracePayload(v) : v;
  }
  return compactedEnvelope;
}

export function formatTraceDate(now = Date.now()): string {
  const d = new Date(now);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTraceFilePath(dir: string, now = Date.now()): string {
  return path.join(dir, `trace-${formatTraceDate(now)}.jsonl`);
}

/** Сжимает завершённый файл трассировки в `.jsonl.zst` потоково с длинным окном и сохранением `mtime`. */
export async function compressTraceFileToZstd(filePath: string): Promise<string | null> {
  const zstdFactory = (zlib as unknown as {
    createZstdCompress?: (options?: Record<string, unknown>) => NodeJS.ReadWriteStream;
  }).createZstdCompress;
  if (typeof zstdFactory !== 'function') return null;

  const targetPath = `${filePath}.zst`;
  const tmpPath = `${targetPath}.tmp`;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;

    const zstdConsts = (zlib as unknown as { constants?: Record<string, number> }).constants || {};
    const params: Record<number, number> = {};
    if (typeof zstdConsts.ZSTD_c_compressionLevel === 'number') {
      params[zstdConsts.ZSTD_c_compressionLevel] = 6;
    }
    if (typeof zstdConsts.ZSTD_c_windowLog === 'number') {
      params[zstdConsts.ZSTD_c_windowLog] = 25;
    }

    const compressor = zstdFactory(Object.keys(params).length > 0 ? { params } : undefined);
    await pipeline(fs.createReadStream(filePath), compressor, fs.createWriteStream(tmpPath));
    await fs.promises.utimes(tmpPath, stat.atime, stat.mtime);
    await fs.promises.rename(tmpPath, targetPath);
    await fs.promises.unlink(filePath);
    return targetPath;
  } catch {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // Игнорируем ошибку очистки временного файла.
    }
    return null;
  }
}

/**
 * Сжимает в zstd завершённые прошлые суточные `trace-*.jsonl` и удаляет файлы старше retentionMs,
 * не трогая сегодняшний активный файл.
 */
export async function cleanupExpiredTraces(options?: TraceWriteOptions): Promise<number> {
  const dir = resolveTraceDir(options?.dir);
  if (!dir) return 0;

  const now = options?.now ?? Date.now();
  const retentionMs = options?.retentionMs ?? TRACE_RETENTION_MS;
  const todayFile = `trace-${formatTraceDate(now)}.jsonl`;
  let removed = 0;

  try {
    const entries = await fs.promises.readdir(dir);
    for (const name of entries) {
      if (!TRACE_FILE_PATTERN.test(name) || name === todayFile) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > retentionMs) {
          await enqueueTraceTask(() => fs.promises.unlink(fullPath));
          removed += 1;
        } else if (!name.endsWith('.zst')) {
          await enqueueTraceTask(() => compressTraceFileToZstd(fullPath));
        }
      } catch {
        // Игнорируем гонку удаления или временную блокировку файла.
      }
    }
  } catch {
    // Каталог логов может ещё не существовать до первой записи.
  }

  return removed;
}

/** Запускает периодическую фоновую очистку и сжатие trace-логов (раз в час, не удерживает процесс). */
export function startTraceCleanup(options?: TraceWriteOptions): void {
  if (cleanupTimer) return;
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

export function stopTraceCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Асинхронно и последовательно дописывает событие трассировки в суточный JSONL-файл. */
export function writeTraceEvent(event: Record<string, unknown>, options?: TraceWriteOptions): void {
  const dir = resolveTraceDir(options?.dir);
  if (!dir) return;

  const now = options?.now ?? Date.now();
  const filePath = getTraceFilePath(dir, now);
  let record: Record<string, unknown> = { ts: new Date(now).toISOString(), ...event };

  if (
    record.phase === 'request' &&
    'payload' in record &&
    typeof record.conversationKey === 'string' &&
    typeof record.requestId === 'string'
  ) {
    record = {
      ...record,
      payload: compactAndSanitizeRequestPayload(
        record.payload,
        filePath,
        record.conversationKey,
        record.requestId,
        options?.sanitizePayload !== false,
      ),
    };
  } else if (options?.sanitizePayload && 'payload' in record) {
    record = { ...record, payload: sanitizeTracePayload(record.payload) };
  }

  let line: string;
  try {
    line = JSON.stringify(record) + '\n';
  } catch {
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
