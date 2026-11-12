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

    // Check that structured error was emitted for Go SDK
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
});
