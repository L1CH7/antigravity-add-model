import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { CustomModel } from '../proxy';
import { runCustomModelRequest, stopCustomRequests } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

function model(apiUrl: string, fields: Partial<CustomModel> = {}): CustomModel {
  return {
    name: `models/${randomUUID()}`,
    displayName: 'test-resilience',
    description: '',
    provider: 'openai',
    apiKey: 'secret-test-token',
    externalModelName: 'test-model',
    apiUrl,
    maxRetries: 0,
    ...fields,
  };
}

describe('stream resilience and Go SDK compatibility', () => {
  it('translates stream mid-flight error into Google structured error without breaking Go client', async () => {
    const upstream = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 1. Emit thought chunk to commit headers
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'thinking about the problem...' } }],
        })}\n\n`,
      );
      // 2. Emit an upstream stream error chunk
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            error: { message: 'Upstream gateway overload: context exceeded', code: 503 },
          })}\n\n`,
        );
        res.end();
      }, 50);
    });

    const configured = model(upstream);
    const proxyUrl = await serve((req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'Solve riddle' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(response.status).toBe(200);
    const bodyText = await response.text();

    // Check that thinking part was emitted first
    expect(bodyText).toContain('thinking about the problem...');

    // Check that structured error was emitted as a valid SSE data line for Go SDK
    expect(bodyText).toContain('data: {"error":');
    expect(bodyText).toContain('"status":"INTERNAL"');
    expect(bodyText).toContain('Upstream gateway overload: context exceeded');

    // Crucial check: verify it does NOT contain 'event: error' (which broke Go's iterateResponseStream)
    expect(bodyText).not.toContain('event: error');
  });

  it('reports an honest error when the stream ends with only thoughts and never stores a blank turn', async () => {
    const upstream = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Emit only thinking chunks, then stop
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'Finished reasoning completely.' } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const configured = model(upstream);
    const proxyUrl = await serve((req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'Solve riddle' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    const bodyText = await response.text();

    // The thought must reach the client, so long reasoning is not thrown away.
    expect(bodyText).toContain('Finished reasoning completely.');

    // No blank visible text placeholder may ever be written; the turn carries no empty answer.
    expect(bodyText).not.toContain('"text":" "');

    // Both the explicit finish reason and the empty tail candidate are still reported as empty content.
    expect(bodyText).toContain('"finishReason":"STOP"');
  });

  it('forwards usageMetadata, modelVersion and responseId in Google SSE streams', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
          modelVersion: 'gemini-3.8-flash-low',
          responseId: 'resp_123',
        })}\n\n`,
      );
      res.end();
    });

    const configured = model(upstream, { provider: 'google', apiFormat: 'google', externalModelName: 'gemini-3.8-flash-low' });
    const proxyUrl = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).toContain('"promptTokenCount":12');
    expect(bodyText).toContain('"candidatesTokenCount":3');
    expect(bodyText).toContain('"modelVersion":"gemini-3.8-flash-low"');
    expect(bodyText).toContain('"responseId":"resp_123"');
  });

  it('buffers leading whitespace chunk so upstream_unavailable retries transparently before committing 200', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' ' } }] })}\n\n`);
      setTimeout(() => {
        if (attempts === 1) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: 'No upstream channels are currently available (smart_route_stream_commit_failure)',
                type: 'upstream_unavailable',
                code: 'upstream_unavailable',
              },
            })}\n\n`,
          );
          res.end();
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 20);
    });

    const configured = model(upstream, { maxRetries: 1 });
    const proxyUrl = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    const bodyText = await response.text();
    expect(bodyText).toContain('"text":" "');
    expect(bodyText).toContain('"text":"OK"');
    expect(bodyText).toContain('"finishReason":"STOP"');
    expect(bodyText).not.toContain('upstream_unavailable');
  });

  it('returns HTTP 424 after exhausted retries on leading-whitespace upstream_unavailable to stop IDE retry storm', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' ' } }] })}\n\n`);
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: 'upstream_error (smart_route_stream_commit_failure)',
              type: 'upstream_unavailable',
              code: 'upstream_unavailable',
            },
          })}\n\n`,
        );
        res.end();
      }, 20);
    });

    const configured = model(upstream, { maxRetries: 1 });
    const proxyUrl = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(attempts).toBe(2);
    expect(response.status).toBe(424);
    const payload = (await response.json()) as { error: { code: number; upstreamStatus: number; message: string } };
    expect(payload.error.code).toBe(424);
    expect(payload.error.upstreamStatus).toBe(502);
    expect(payload.error.message).toContain('smart_route_stream_commit_failure');
  });

  it('maps HTTP 503 model_not_found to HTTP 404 without retrying', async () => {
    let attempts = 0;
    const upstream = await serve((_req, res) => {
      attempts += 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'No available channel for model gpt-6.1-terra',
            type: 'api_error',
            code: 'model_not_found',
          },
        }),
      );
    });

    const configured = model(upstream, { maxRetries: 2 });
    const proxyUrl = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(attempts).toBe(1);
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error: { code: number; upstreamStatus: number } };
    expect(payload.error.code).toBe(404);
    expect(payload.error.upstreamStatus).toBe(503);
  });

  it('preserves whitespace-only valid completion when stream terminates cleanly with STOP', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '   ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const configured = model(upstream, { maxRetries: 0 });
    const proxyUrl = await serve((_req, res) => {
      void runCustomModelRequest(
        res,
        configured,
        { contents: [{ role: 'user', parts: [{ text: 'spaces' }] }] },
        true,
        [configured],
        false,
      );
    });

    const response = await fetch(proxyUrl, { method: 'POST' });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).toContain('"text":"   "');
    expect(bodyText).toContain('"finishReason":"STOP"');
  });
});
