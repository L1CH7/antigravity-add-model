import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredTraces,
  formatTraceDate,
  maskSecretValue,
  sanitizeTraceHeaders,
  sanitizeTracePayload,
  TRACE_RETENTION_MS,
  writeTraceEvent,
} from '../proxy/traceLog';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('traceLog', () => {
  it('masks middle of API keys while keeping scheme and outer characters for identification', () => {
    expect(maskSecretValue('Bearer sk-proj-1234567890abcdef')).toBe('Bearer sk-pro...cdef');
    expect(maskSecretValue('AIzaSyD1234567890')).toBe('AIzaSy...7890');
    expect(maskSecretValue('short')).toBe('***');

    const headers = sanitizeTraceHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-abcdef123456',
      'x-api-key': 'secret_99887766',
      'User-Agent': 'antigravity',
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-tes...3456',
      'x-api-key': 'secret...7766',
      'User-Agent': 'antigravity',
    });
  });

  it('preserves full text, thoughts and tool_calls while replacing large base64 blobs with metadata', () => {
    const bigB64 = 'A'.repeat(400);
    const payload = {
      model: 'gpt-6.1-sol',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Очень длинный текст запроса целиком без обрезки' },
            { type: 'file', file: { filename: 'document-1.pdf', file_data: `data:application/pdf;base64,${bigB64}` } },
          ],
        },
        {
          role: 'assistant',
          reasoning_content: 'Полные мысли модели',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ask_question', arguments: '{"a":1}' } }],
        },
      ],
      inlinePart: { inlineData: { mimeType: 'image/png', data: bigB64 } },
      smallDataUrl: 'data:image/png;base64,QUJDRA==',
    };

    const sanitized = sanitizeTracePayload(payload) as Record<string, any>;
    expect(sanitized.messages[0].content[0].text).toBe('Очень длинный текст запроса целиком без обрезки');
    expect(sanitized.messages[0].content[1].file.file_data).toMatch(
      /^data:application\/pdf;base64,<base64:application\/pdf, 400 chars, sha256=[a-f0-9]{12}>$/,
    );
    expect(sanitized.messages[1].reasoning_content).toBe('Полные мысли модели');
    expect(sanitized.messages[1].tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(sanitized.inlinePart.inlineData.data).toMatch(/^<base64:image\/png, 400 chars, sha256=[a-f0-9]{12}>$/);
    expect(sanitized.smallDataUrl).toBe('data:image/png;base64,QUJDRA==');
  });

  it('writes daily JSONL trace file and cleans up files older than 24h while keeping today and recent files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trace-test-'));
    createdDirs.push(dir);
    const now = new Date('2026-11-17T20:00:00Z').getTime();

    writeTraceEvent({ phase: 'request', model: 'gpt-6.1-sol', text: 'hello' }, { dir, now });
    await new Promise((r) => setTimeout(r, 40));

    const todayName = `trace-${formatTraceDate(now)}.jsonl`;
    const todayPath = path.join(dir, todayName);
    expect(fs.existsSync(todayPath)).toBe(true);
    const lines = fs.readFileSync(todayPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).model).toBe('gpt-6.1-sol');

    const stalePath = path.join(dir, `trace-${formatTraceDate(now - 2 * TRACE_RETENTION_MS)}.jsonl`);
    const freshYesterdayPath = path.join(dir, `trace-${formatTraceDate(now - TRACE_RETENTION_MS + 3_600_000)}.jsonl`);
    const unrelatedPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(stalePath, '{"stale":true}\n');
    fs.writeFileSync(freshYesterdayPath, '{"fresh":true}\n');
    fs.writeFileSync(unrelatedPath, 'keep');

    const staleTime = new Date(now - TRACE_RETENTION_MS - 60_000);
    const recentTime = new Date(now - TRACE_RETENTION_MS + 3_600_000);
    fs.utimesSync(stalePath, staleTime, staleTime);
    fs.utimesSync(freshYesterdayPath, recentTime, recentTime);

    const removed = await cleanupExpiredTraces({ dir, now });
    expect(removed).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshYesterdayPath)).toBe(true);
    expect(fs.existsSync(todayPath)).toBe(true);
    expect(fs.existsSync(unrelatedPath)).toBe(true);
  });
});
