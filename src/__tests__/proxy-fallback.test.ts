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

describe('Antigravity Manager Seamless Fallback to Google PA', () => {
  it('transparently triggers fallbackToGoogle without sending 502 when port 8045 is down/unreachable', async () => {
    // Port 59998 is closed/not listening (simulates Antigravity Manager stopped)
    const deadModel: CustomModel = {
      name: 'models/gemini-3.8-flash-high',
      displayName: 'Gemini 3.8 Flash High (Native)',
      provider: 'google',
      apiUrl: 'http://127.0.0.1:59998/v1beta',
      apiKey: 'test-key',
      externalModelName: 'gemini-3.8-flash-high',
      maxRetries: 0,
      timeout: 1000,
    };

    let fallbackCalled = false;
    let clientGotError = false;

    // Simulate incoming client response object
    const serverUrl = await serve(async (req, res) => {
      const fallbackToGoogle = () => {
        fallbackCalled = true;
        // In actual proxy, this forwards to proxyToGoogle
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'Served by native Google Cloud Code PA' }));
      };

      await runCustomModelRequest(
        res,
        deadModel,
        { contents: [{ role: 'user', parts: [{ text: 'test query' }] }] },
        true,
        [deadModel],
        true,
        fallbackToGoogle,
      );
    });

    const response = await fetch(serverUrl);
    expect(fallbackCalled).toBe(true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe('Served by native Google Cloud Code PA');
  });

  it('uses custom model upstream and does NOT trigger fallback when Antigravity Manager is running', async () => {
    // Live mock Antigravity Manager server on port
    const liveUpstream = await serve((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'From Antigravity Manager Pool' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const liveModel: CustomModel = {
      name: 'models/gemini-3.8-flash-high',
      displayName: 'Gemini 3.8 Flash High (Native)',
      provider: 'openai',
      apiUrl: `${liveUpstream}/v1/chat/completions`,
      apiKey: 'test-key',
      externalModelName: 'gemini-3.8-flash-high',
      maxRetries: 0,
    };

    let fallbackCalled = false;
    const serverUrl = await serve(async (req, res) => {
      const fallbackToGoogle = () => {
        fallbackCalled = true;
      };

      await runCustomModelRequest(
        res,
        liveModel,
        { contents: [{ role: 'user', parts: [{ text: 'test query' }] }] },
        true,
        [liveModel],
        true,
        fallbackToGoogle,
      );
    });

    const response = await fetch(serverUrl);
    expect(fallbackCalled).toBe(false);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('From Antigravity Manager Pool');
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
