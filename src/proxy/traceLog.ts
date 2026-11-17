/**
 * Суточное трассировочное логирование запросов и ответов прокси в формате JSONL.
 * Хранит полные тексты, мысли, вызовы инструментов и диагностику без обрезки,
 * маскируя лишь середину секретов в заголовках и заменяя длинные base64-блобы на метаданные.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

export const TRACE_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TRACE_FILE_PATTERN = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const BASE64_OMIT_THRESHOLD = 256;

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
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastCleanupAt = 0;

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

/** Удаляет устаревшие trace-*.jsonl старше retentionMs (по умолчанию 24 ч), не трогая сегодняшний файл. */
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
        if (stat.isFile() && now - stat.mtimeMs > retentionMs) {
          await fs.promises.unlink(fullPath);
          removed += 1;
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

/** Запускает периодическую фоновую очистку trace-логов (раз в час, не удерживает процесс). */
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

/** Асинхронно дописывает событие трассировки в суточный JSONL-файл и при необходимости запускает ротационную очистку. */
export function writeTraceEvent(event: Record<string, unknown>, options?: TraceWriteOptions): void {
  const dir = resolveTraceDir(options?.dir);
  if (!dir) return;

  const now = options?.now ?? Date.now();
  const filePath = getTraceFilePath(dir, now);
  const record = { ts: new Date(now).toISOString(), ...event };
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

  void fs.promises
    .mkdir(dir, { recursive: true })
    .then(() => fs.promises.appendFile(filePath, line, 'utf8'))
    .catch(() => {
      // Логирование не должно нарушать обработку запросов прокси.
    });
}
