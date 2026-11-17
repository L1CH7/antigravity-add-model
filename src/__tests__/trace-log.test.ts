import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredTraces,
  compressTraceFileToZstd,
  flushTraceWrites,
  formatTraceDate,
  maskSecretValue,
  resetTraceLogState,
  sanitizeTraceHeaders,
  sanitizeTracePayload,
  TRACE_RETENTION_MS,
  writeTraceEvent,
} from '../proxy/traceLog';

const createdDirs: string[] = [];

afterEach(async () => {
  await flushTraceWrites();
  resetTraceLogState();
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

  it('serializes concurrent large writes without interleaving JSONL lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trace-race-'));
    createdDirs.push(dir);
    const now = new Date('2026-11-18T01:10:00Z').getTime();

    const bigText = 'x'.repeat(200_000);
    for (let i = 0; i < 8; i++) {
      writeTraceEvent(
        {
          phase: 'request',
          requestId: `req-${i}`,
          conversationKey: `conv-${i}`,
          payload: { messages: [{ role: 'user', content: `${i}:${bigText}` }] },
        },
        { dir, now },
      );
    }
    await flushTraceWrites();

    const todayPath = path.join(dir, `trace-${formatTraceDate(now)}.jsonl`);
    const lines = fs.readFileSync(todayPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(8);
    lines.forEach((line, idx) => {
      const parsed = JSON.parse(line);
      expect(parsed.requestId).toBe(`req-${idx}`);
    });
  });

  it('compacts unchanged tools, system instructions, and message prefix in human-readable form without hashes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trace-delta-'));
    createdDirs.push(dir);
    const now = new Date('2026-11-18T01:20:00Z').getTime();

    const tools = [
      { type: 'function', function: { name: 'run_command', parameters: { type: 'object', required: ['CommandLine'] } } },
    ];
    const systemMsg = { role: 'system', content: 'Большая системная инструкция '.repeat(200) };
    const user1 = { role: 'user', content: 'Первый вопрос' };
    const assistant1 = { role: 'assistant', content: 'Первый ответ' };
    const user2 = { role: 'user', content: 'Второй вопрос' };

    writeTraceEvent(
      {
        phase: 'request',
        requestId: 'req-1',
        conversationKey: 'conv-alpha',
        payload: { model: 'gpt-6.1-sol', system: 'Sys', tools, messages: [systemMsg, user1] },
      },
      { dir, now },
    );
    writeTraceEvent(
      {
        phase: 'request',
        requestId: 'req-2',
        conversationKey: 'conv-alpha',
        payload: { model: 'gpt-6.1-sol', system: 'Sys', tools, messages: [systemMsg, user1, assistant1, user2] },
      },
      { dir, now: now + 1000 },
    );
    await flushTraceWrites();

    const todayPath = path.join(dir, `trace-${formatTraceDate(now)}.jsonl`);
    const [first, second] = fs
      .readFileSync(todayPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    expect(first.payload.tools).toEqual(tools);
    expect(first.payload.messages).toHaveLength(2);

    expect(second.payload.tools).toBe('[без изменений — как в req req-1 (1 шт.)]');
    expect(second.payload.system).toBe('[без изменений — как в req req-1 (5 симв.)]');
    expect(second.payload.messages).toEqual([
      { _reusedPrefix: 'первые 2 сообщ. без изменений — см. req req-1' },
      assistant1,
      user2,
    ]);
  });

  it('compresses past daily trace files with zstd and cleans up expired .jsonl and .jsonl.zst files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trace-test-'));
    createdDirs.push(dir);
    const now = new Date('2026-11-18T10:00:00Z').getTime();

    writeTraceEvent({ phase: 'request', model: 'gpt-6.1-sol', text: 'hello' }, { dir, now });
    await flushTraceWrites();

    const todayPath = path.join(dir, `trace-${formatTraceDate(now)}.jsonl`);
    expect(fs.existsSync(todayPath)).toBe(true);

    const stalePath = path.join(dir, `trace-${formatTraceDate(now - 2 * TRACE_RETENTION_MS)}.jsonl.zst`);
    const freshYesterdayPath = path.join(dir, `trace-${formatTraceDate(now - TRACE_RETENTION_MS + 3_600_000)}.jsonl`);
    const unrelatedPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(stalePath, 'stale-zst');
    const freshBody = '{"fresh":true}\n'.repeat(20);
    fs.writeFileSync(freshYesterdayPath, freshBody);
    fs.writeFileSync(unrelatedPath, 'keep');

    const staleTime = new Date(now - TRACE_RETENTION_MS - 60_000);
    const recentTime = new Date(now - TRACE_RETENTION_MS + 3_600_000);
    fs.utimesSync(stalePath, staleTime, staleTime);
    fs.utimesSync(freshYesterdayPath, recentTime, recentTime);

    const removed = await cleanupExpiredTraces({ dir, now });
    await flushTraceWrites();

    expect(removed).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(todayPath)).toBe(true);
    expect(fs.existsSync(unrelatedPath)).toBe(true);

    const zstdCompressSupported = typeof (zlib as unknown as { createZstdCompress?: unknown }).createZstdCompress === 'function';
    if (zstdCompressSupported) {
      expect(fs.existsSync(freshYesterdayPath)).toBe(false);
      const zstPath = `${freshYesterdayPath}.zst`;
      expect(fs.existsSync(zstPath)).toBe(true);
      const decompressed = (zlib as unknown as { zstdDecompressSync: (buf: Buffer) => Buffer })
        .zstdDecompressSync(fs.readFileSync(zstPath))
        .toString('utf8');
      expect(decompressed).toBe(freshBody);
    } else {
      expect(await compressTraceFileToZstd(freshYesterdayPath)).toBeNull();
    }
  });
});
