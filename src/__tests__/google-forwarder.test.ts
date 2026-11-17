import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  fetchGoogleBuffer,
  forwardToGoogle,
  getGoogleForwarderStats,
  resolveGoogleIpFamily,
  stopGoogleForwarder,
} from '../proxy/googleForwarder';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let certDir = '';
let keyPem = Buffer.alloc(0);
let certPem = Buffer.alloc(0);

const servers: Array<http.Server | http2.Http2SecureServer> = [];

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-h2-cert-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  keyPem = fs.readFileSync(keyPath);
  certPem = fs.readFileSync(certPath);
});

afterEach(async () => {
  stopGoogleForwarder();
  await Promise.all(
    servers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    ),
  );
});

afterAll(() => {
  if (certDir) {
    fs.rmSync(certDir, { recursive: true, force: true });
  }
});

async function serveHttp2(
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
): Promise<{ host: string; server: http2.Http2SecureServer }> {
  const server = http2.createSecureServer({ key: keyPem, cert: certPem });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    handler(stream, headers);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { host: `127.0.0.1:${port}`, server };
}

async function serveProxy(
  targetHost: string,
  options: {
    isGeneration?: boolean;
    shouldBufferAndModify?: boolean;
    streamTimeoutMs?: number;
    metadataTimeoutMs?: number;
    pingIntervalMs?: number;
    warmIdleMs?: number;
    sseKeepaliveMs?: number;
    transformBody?: (body: string) => string;
  } = {},
): Promise<string> {
  const proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      forwardToGoogle({
        req,
        res,
        reqBody: Buffer.concat(chunks),
        targetHost,
        isGeneration: options.isGeneration ?? true,
        shouldBufferAndModify: options.shouldBufferAndModify ?? false,
        streamTimeoutMs: options.streamTimeoutMs,
        metadataTimeoutMs: options.metadataTimeoutMs,
        pingIntervalMs: options.pingIntervalMs,
        warmIdleMs: options.warmIdleMs,
        sseKeepaliveMs: options.sseKeepaliveMs,
        transformBody: options.transformBody,
        http2ConnectOptions: { ca: certPem },
      });
    });
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

describe('googleForwarder', () => {
  it('parses ANTIGRAVITY_GOOGLE_IP_FAMILY configuration cleanly', () => {
    expect(resolveGoogleIpFamily(undefined)).toBeUndefined();
    expect(resolveGoogleIpFamily('auto')).toBeUndefined();
    expect(resolveGoogleIpFamily('4')).toBe(4);
    expect(resolveGoogleIpFamily('IPv4')).toBe(4);
    expect(resolveGoogleIpFamily('6')).toBe(6);
    expect(resolveGoogleIpFamily('ipv6')).toBe(6);
  });

  it('multiplexes requests over a single warm HTTP/2 session and sends PING while waiting', async () => {
    let sessionCount = 0;
    let pingCount = 0;

    const { host, server } = await serveHttp2((stream, headers) => {
      const delay = headers[':path'] === '/slow' ? 95 : 5;
      setTimeout(() => {
        if (stream.closed || stream.destroyed) return;
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        stream.write(`data: path=${headers[':path']}\n\n`);
        stream.end();
      }, delay);
    });

    server.on('session', (session) => {
      sessionCount += 1;
      session.on('ping', () => {
        pingCount += 1;
      });
    });

    const proxyUrl = await serveProxy(host, {
      isGeneration: true,
      pingIntervalMs: 25,
      warmIdleMs: 500,
    });

    const [slowRes, fastRes] = await Promise.all([
      fetch(`${proxyUrl}/slow`, { method: 'POST', body: '{}' }),
      fetch(`${proxyUrl}/fast`, { method: 'POST', body: '{}' }),
    ]);

    expect(slowRes.status).toBe(200);
    expect(fastRes.status).toBe(200);
    expect(await slowRes.text()).toContain('path=/slow');
    expect(await fastRes.text()).toContain('path=/fast');
    expect(sessionCount).toBe(1);
    expect(pingCount).toBeGreaterThanOrEqual(2);
    expect(getGoogleForwarderStats()).toEqual({ activeSessions: 1, totalActiveStreams: 0 });
  });

  it('retries transparently when upstream resets HTTP/2 stream before response headers', async () => {
    let attempts = 0;
    const { host } = await serveHttp2((stream) => {
      attempts += 1;
      if (attempts === 1) {
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ ok: true, attempt: attempts }));
    });

    const proxyUrl = await serveProxy(host, { isGeneration: true, pingIntervalMs: 50 });
    const response = await fetch(`${proxyUrl}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      body: '{"model":"gemini-4-hydrogen-high"}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, attempt: 2 });
    expect(attempts).toBe(2);
  });

  it('cancels the upstream HTTP/2 stream when the client disconnects early', async () => {
    let upstreamClosed = false;
    let streamOpenedResolve: () => void;
    const streamOpened = new Promise<void>((resolve) => {
      streamOpenedResolve = resolve;
    });

    const { host } = await serveHttp2((stream) => {
      stream.on('close', () => {
        upstreamClosed = true;
      });
      streamOpenedResolve();
    });

    const proxyUrl = await serveProxy(host, { isGeneration: true, streamTimeoutMs: 5000, pingIntervalMs: 100 });
    const controller = new AbortController();
    const pending = fetch(`${proxyUrl}/abort`, { method: 'POST', body: '{}', signal: controller.signal }).catch(
      () => undefined,
    );

    await streamOpened;
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(upstreamClosed).toBe(true);
    expect(getGoogleForwarderStats().totalActiveStreams).toBe(0);
  });

  it('decompresses gzip metadata responses and applies transformBody with updated content-length', async () => {
    const { host } = await serveHttp2((stream) => {
      const payload = JSON.stringify({
        endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1',
        RemoteControlEnabled: true,
      });
      const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
      stream.respond({
        ':status': 200,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      stream.end(gz);
    });

    const proxyUrl = await serveProxy(host, {
      isGeneration: false,
      shouldBufferAndModify: true,
      transformBody: (text) =>
        text
          .replace(/https:\/\/daily-cloudcode-pa\.googleapis\.com/g, 'http://127.0.0.1:50999')
          .replace(/"RemoteControlEnabled":true/g, '"RemoteControlEnabled":false'),
    });

    const response = await fetch(`${proxyUrl}/v1internal:listExperiments`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { endpoint: string; RemoteControlEnabled: boolean };
    expect(parsed.endpoint).toBe('http://127.0.0.1:50999/v1');
    expect(parsed.RemoteControlEnabled).toBe(false);
  });

  it('falls back to HTTP/1.1 for http:// targets and returns 504 on pre-header timeout', async () => {
    const http1Server = http.createServer((req, res) => {
      if (req.url === '/timeout') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proto: 'http1' }));
    });
    servers.push(http1Server);
    await new Promise<void>((resolve) => http1Server.listen(0, '127.0.0.1', resolve));
    const httpPort = (http1Server.address() as { port: number }).port;

    const proxyUrl = await serveProxy(`http://127.0.0.1:${httpPort}`, {
      isGeneration: true,
      streamTimeoutMs: 60,
    });

    const okRes = await fetch(`${proxyUrl}/ok`, { method: 'POST', body: '{}' });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ proto: 'http1' });

    const timeoutRes = await fetch(`${proxyUrl}/timeout`, { method: 'POST', body: '{}' });
    expect(timeoutRes.status).toBe(504);
  });

  it('emits SSE keepalive newlines only when stream pauses after 200 text/event-stream headers', async () => {
    const { host } = await serveHttp2((stream, headers) => {
      if (headers[':path'] === '/err') {
        stream.respond({ ':status': 500, 'content-type': 'application/json' });
        setTimeout(() => stream.end('{"error":"fail"}'), 85);
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.write('data: {"hello":1}\n\n');
      setTimeout(() => {
        stream.end('data: {"done":true}\n\n');
      }, 95);
    });

    const proxyUrl = await serveProxy(host, {
      isGeneration: true,
      pingIntervalMs: 200,
      sseKeepaliveMs: 25,
    });

    const sseRes = await fetch(`${proxyUrl}/sse`, { method: 'POST', body: '{}' });
    const sseText = await sseRes.text();
    expect(sseRes.status).toBe(200);
    expect(sseText).toContain('data: {"hello":1}\n\n');
    expect(sseText).toContain('\n\n\n\n');
    expect(sseText).toContain('data: {"done":true}\n\n');

    const errRes = await fetch(`${proxyUrl}/err`, { method: 'POST', body: '{}' });
    expect(errRes.status).toBe(500);
    expect(await errRes.text()).toBe('{"error":"fail"}');
  });

  it('fetches gzipped metadata over warm HTTP/2 via fetchGoogleBuffer and enforces pre-header timeout', async () => {
    let sessionCount = 0;
    const { host, server } = await serveHttp2((stream, headers) => {
      if (headers[':path'] === '/hang') return;
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ models: ['gemini-4-hydrogen-high'] })));
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'content-encoding': 'gzip' });
      stream.end(gz);
    });
    server.on('session', () => {
      sessionCount += 1;
    });

    const first = await fetchGoogleBuffer({
      targetHost: host,
      path: '/v1internal:fetchAvailableModels',
      method: 'POST',
      reqBody: Buffer.from('{}'),
      timeoutMs: 2000,
      http2ConnectOptions: { ca: certPem },
    });
    const second = await fetchGoogleBuffer({
      targetHost: host,
      path: '/v1internal:fetchAvailableModels',
      method: 'POST',
      reqBody: Buffer.from('{}'),
      timeoutMs: 2000,
      http2ConnectOptions: { ca: certPem },
    });

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body.toString('utf8'))).toEqual({ models: ['gemini-4-hydrogen-high'] });
    expect(JSON.parse(second.body.toString('utf8'))).toEqual({ models: ['gemini-4-hydrogen-high'] });
    expect(sessionCount).toBe(1);

    await expect(
      fetchGoogleBuffer({
        targetHost: host,
        path: '/hang',
        method: 'GET',
        timeoutMs: 60,
        http2ConnectOptions: { ca: certPem },
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
