import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { CustomModel } from '../proxy';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/mock/home';
      return '/mock/' + name;
    }),
    getAppPath: vi.fn(() => '/mock/app'),
  },
}));

const servers: http.Server[] = [];
afterEach(async () => {
  stopCustomRequests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
afterAll(stopCleanupInterval);

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('Antigravity Manager upstream error propagation', () => {
  it('propagates the real upstream status and body instead of a generic 502', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid_request: content must not be empty', code: 'invalid_request' } }));
    });

    const model: CustomModel = {
      name: 'models/test-openai',
      displayName: 'Test OpenAI',
      provider: 'openai',
      apiUrl: `${upstream}/v1/chat/completions`,
      apiKey: 'test-key',
      externalModelName: 'test-model',
      maxRetries: 0,
    };

    const serverUrl = await serve(async (_req, res) => {
      await runCustomModelRequest(
        res,
        model,
        { contents: [{ role: 'user', parts: [{ text: 'test query' }] }] },
        false,
        [model],
        false,
      );
    });

    const response = await fetch(serverUrl);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain('invalid_request');
    expect(body.error.upstreamStatus).toBe(400);
  });

  it('serves the configured model and never switches to another one', async () => {
    const calls: string[] = [];
    const upstream = await serve((req, res) => {
      calls.push(req.url!);
      if (req.url!.includes('/bad')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request', code: 'invalid_request' } }));
      } else {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'from primary' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const secondary: CustomModel = {
      name: 'models/secondary',
      displayName: 'Secondary',
      provider: 'openai',
      apiUrl: `${upstream}/good`,
      apiKey: 'test-key',
      externalModelName: 'secondary',
      maxRetries: 0,
    };
    const primary: CustomModel = {
      name: 'models/primary',
      displayName: 'Primary',
      provider: 'openai',
      apiUrl: `${upstream}/bad`,
      apiKey: 'test-key',
      externalModelName: 'primary',
      maxRetries: 0,
    };

    const serverUrl = await serve(async (_req, res) => {
      await runCustomModelRequest(
        res,
        primary,
        { contents: [{ role: 'user', parts: [{ text: 'test query' }] }] },
        false,
        [primary, secondary],
        false,
      );
    });

    const response = await fetch(serverUrl);
    expect(response.status).toBe(400);
    expect(calls).toEqual(['/bad/chat/completions']);
  });

  it('guarantees NATIVE_GOOGLE_MODELS contains all standard Antigravity Gemini and Claude models', async () => {
    const { NATIVE_GOOGLE_MODELS, isNativeGoogleModelName } = await import('../proxy/modelUtils');
    const names = NATIVE_GOOGLE_MODELS.map((m) => m.name);

    expect(names).toContain('models/gemini-3.8-flash-high');
    expect(names).toContain('models/gemini-3.8-flash-medium');
    expect(names).toContain('models/gemini-3.8-flash-low');
    expect(names).toContain('models/gemini-3.8-flash-tiered');
    expect(names).toContain('models/gemini-3.7-flash-high');
    expect(names).toContain('models/gemini-3.7-flash-medium');
    expect(names).toContain('models/gemini-3.7-flash-low');
    expect(names).toContain('models/gemini-3.7-flash-tiered');
    expect(names).toContain('models/gemini-2.5-pro');
    expect(names).toContain('models/gemini-2.5-flash');
    expect(names).toContain('models/claude-3-7-sonnet');
    expect(names).toContain('models/claude-3-5-sonnet');

    expect(isNativeGoogleModelName('gemini-3.8-flash-high')).toBe(true);
    expect(isNativeGoogleModelName('claude-3-7-sonnet')).toBe(true);
    expect(isNativeGoogleModelName('MODEL_PLACEHOLDER_M123')).toBe(false);
    expect(isNativeGoogleModelName('custom-gemini-3.8')).toBe(false);
  });
});
