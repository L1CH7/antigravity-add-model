"use strict";
/**
 * Persistent HTTP/2 forwarder for native Google Cloud Code and AI Studio traffic.
 * Multiplexes requests over a warm HTTP/2 session with periodic PING frames during
 * active/warm windows to prevent ~33s idle-stream disconnects and cold TLS handshakes.
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveGoogleIpFamily = resolveGoogleIpFamily;
exports.forwardToGoogle = forwardToGoogle;
exports.fetchGoogleBuffer = fetchGoogleBuffer;
exports.stopGoogleForwarder = stopGoogleForwarder;
exports.getGoogleForwarderStats = getGoogleForwarderStats;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const http2 = __importStar(require("http2"));
const zlib = __importStar(require("zlib"));
const electron_log_1 = __importDefault(require("electron-log"));
const DEFAULT_STREAM_TIMEOUT_MS = 900000;
const DEFAULT_METADATA_TIMEOUT_MS = 60000;
const DEFAULT_PING_INTERVAL_MS = 8000;
const DEFAULT_WARM_IDLE_MS = 120000;
const DEFAULT_SSE_KEEPALIVE_MS = 45000;
const AUTO_SELECT_FAMILY_TIMEOUT_MS = 150;
const MAX_RETRY_ATTEMPTS = 2;
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'http2-settings',
]);
const sessionPool = new Map();
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 5000 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 5000 });
function resolveGoogleIpFamily(envValue = process.env.ANTIGRAVITY_GOOGLE_IP_FAMILY) {
    const normalized = (envValue || '').trim().toLowerCase();
    if (normalized === '4' || normalized === 'ipv4')
        return 4;
    if (normalized === '6' || normalized === 'ipv6')
        return 6;
    return undefined;
}
function buildSocketConnectOptions() {
    const family = resolveGoogleIpFamily();
    if (family)
        return { family };
    return { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_TIMEOUT_MS };
}
function retireSession(origin, entry) {
    if (entry.closed)
        return;
    entry.closed = true;
    if (entry.pingTimer) {
        clearInterval(entry.pingTimer);
        entry.pingTimer = undefined;
    }
    if (sessionPool.get(origin) === entry) {
        sessionPool.delete(origin);
    }
    if (!entry.session.closed && !entry.session.destroyed) {
        try {
            entry.session.destroy();
        }
        catch {
            // Ignore teardown errors on an already-closing session.
        }
    }
}
function ensurePingTimer(entry, pingIntervalMs, warmIdleMs) {
    if (entry.closed || entry.pingTimer)
        return;
    entry.pingTimer = setInterval(() => {
        if (entry.closed || entry.session.closed || entry.session.destroyed) {
            retireSession(entry.origin, entry);
            return;
        }
        const idleFor = Date.now() - entry.lastActivityAt;
        if (entry.activeStreams === 0 && idleFor >= warmIdleMs) {
            clearInterval(entry.pingTimer);
            entry.pingTimer = undefined;
            return;
        }
        try {
            entry.session.ping((err) => {
                if (err && !entry.closed) {
                    electron_log_1.default.warn(`[Proxy] HTTP/2 ping failed for ${entry.origin}: ${err.message}`);
                    retireSession(entry.origin, entry);
                }
            });
        }
        catch {
            retireSession(entry.origin, entry);
        }
    }, pingIntervalMs);
    entry.pingTimer.unref?.();
}
function getOrCreateHttp2Session(origin, pingIntervalMs, warmIdleMs, extraOptions) {
    const existing = sessionPool.get(origin);
    if (existing && !existing.closed && !existing.goawayReceived && !existing.session.closed && !existing.session.destroyed) {
        ensurePingTimer(existing, pingIntervalMs, warmIdleMs);
        return existing;
    }
    const connectOpts = {
        settings: { enablePush: false },
        ...buildSocketConnectOptions(),
        ...extraOptions,
    };
    const session = http2.connect(origin, connectOpts);
    const entry = {
        origin,
        session,
        activeStreams: 0,
        lastActivityAt: Date.now(),
        pingTimer: undefined,
        closed: false,
        goawayReceived: false,
    };
    sessionPool.set(origin, entry);
    ensurePingTimer(entry, pingIntervalMs, warmIdleMs);
    session.on('goaway', () => {
        entry.goawayReceived = true;
        if (sessionPool.get(origin) === entry) {
            sessionPool.delete(origin);
        }
    });
    session.on('close', () => {
        retireSession(origin, entry);
    });
    session.on('error', (err) => {
        electron_log_1.default.warn(`[Proxy] HTTP/2 session error for ${origin}: ${err.message}`);
        retireSession(origin, entry);
    });
    return entry;
}
function buildHttp2Headers(method, parsedUrl, rawHeaders, reqBody, shouldBufferAndModify) {
    const out = {
        ':method': method,
        ':path': `${parsedUrl.pathname}${parsedUrl.search}`,
        ':authority': parsedUrl.host,
        ':scheme': parsedUrl.protocol.replace(':', ''),
    };
    for (const [rawKey, value] of Object.entries(rawHeaders)) {
        if (value === undefined)
            continue;
        const key = rawKey.toLowerCase();
        if (key.startsWith(':') || key === 'host' || HOP_BY_HOP_HEADERS.has(key))
            continue;
        if (key === 'te' && String(value).toLowerCase() !== 'trailers')
            continue;
        if (key === 'accept-encoding' && shouldBufferAndModify)
            continue;
        if (key === 'content-length')
            continue;
        out[key] = value;
    }
    if (shouldBufferAndModify) {
        out['accept-encoding'] = 'gzip';
    }
    if (reqBody.length > 0) {
        out['content-length'] = String(reqBody.length);
    }
    return out;
}
function maybeGunzip(rawBody, rawHeaders) {
    const encoding = rawHeaders['content-encoding'];
    const encStr = Array.isArray(encoding) ? encoding[0] : encoding;
    if (encStr === 'gzip') {
        try {
            return { body: zlib.gunzipSync(rawBody), encoding: encStr };
        }
        catch (err) {
            electron_log_1.default.error('[Proxy] gunzipSync failed:', err);
            return { body: rawBody, encoding: encStr };
        }
    }
    return { body: rawBody, encoding: encStr };
}
function createSseKeepaliveTracker(res, enabled, intervalMs) {
    if (!enabled || intervalMs <= 0) {
        return { onChunk: () => { }, stop: () => { } };
    }
    let lastEndedWithNewline = true;
    let timer;
    let stopped = false;
    const arm = () => {
        if (timer)
            clearTimeout(timer);
        if (stopped)
            return;
        timer = setTimeout(() => {
            if (stopped || res.writableEnded || res.destroyed)
                return;
            if (lastEndedWithNewline) {
                try {
                    res.write('\n\n');
                }
                catch {
                    stopped = true;
                    return;
                }
            }
            arm();
        }, intervalMs);
        timer.unref?.();
    };
    arm();
    return {
        onChunk(chunk) {
            if (chunk.length > 0) {
                lastEndedWithNewline = chunk[chunk.length - 1] === 0x0a;
            }
            arm();
        },
        stop() {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}
function toOutgoingResponseHeaders(headers) {
    const result = {};
    for (const [rawKey, value] of Object.entries(headers)) {
        if (value === undefined)
            continue;
        const key = rawKey.toLowerCase();
        if (key.startsWith(':') || HOP_BY_HOP_HEADERS.has(key))
            continue;
        result[rawKey] = value;
    }
    return result;
}
function finalizeBufferedResponse(res, statusCode, rawHeaders, rawBody, reqUrl, transformBody) {
    const { body: decodedBody, encoding: encStr } = maybeGunzip(rawBody, rawHeaders);
    const text = decodedBody.toString('utf-8');
    electron_log_1.default.info(`[Proxy] Response for ${reqUrl} (status: ${statusCode}, encoding: ${encStr}, length: ${text.length})`);
    const finalText = transformBody ? transformBody(text) : text;
    const modifiedHeaders = toOutgoingResponseHeaders(rawHeaders);
    delete modifiedHeaders['content-encoding'];
    const modifiedBuffer = Buffer.from(finalText, 'utf-8');
    modifiedHeaders['content-length'] = String(modifiedBuffer.length);
    if (!res.headersSent) {
        res.writeHead(statusCode, modifiedHeaders);
        res.end(modifiedBuffer);
    }
    else if (!res.writableEnded) {
        res.end();
    }
}
function sendProxyError(res, status, message) {
    if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
    }
    else if (!res.writableEnded) {
        res.end();
    }
}
function isRetryablePreHeaderError(err) {
    const code = err.code || '';
    if (code === 'ERR_HTTP2_GOAWAY_SESSION' || code === 'ERR_HTTP2_STREAM_CANCEL' || code === 'ERR_HTTP2_SESSION_ERROR') {
        return true;
    }
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
        return true;
    }
    const msg = err.message || '';
    return /socket hang up|GOAWAY|NGHTTP2_REFUSED_STREAM|Premature close|stream closed/i.test(msg);
}
function attemptHttp1Fallback(opts, parsedUrl, timeoutMs, attempt) {
    const { req, res, reqBody, targetHost, isGeneration, shouldBufferAndModify, transformBody } = opts;
    const headers = {
        ...req.headers,
    };
    headers['host'] = targetHost;
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    if (shouldBufferAndModify) {
        headers['accept-encoding'] = 'gzip';
    }
    if (reqBody.length > 0) {
        headers['content-length'] = String(reqBody.length);
    }
    const sseKeepaliveMs = opts.sseKeepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
    const isHttps = parsedUrl.protocol === 'https:';
    const reqOptions = {
        method: req.method,
        headers: headers,
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        ...buildSocketConnectOptions(),
    };
    let settled = false;
    let headersReceived = false;
    let clientClosed = false;
    let sseKeepalive;
    const proxyReq = (isHttps ? https : http).request(parsedUrl, reqOptions, (proxyRes) => {
        headersReceived = true;
        const statusCode = proxyRes.statusCode || 200;
        if (shouldBufferAndModify) {
            const responseChunks = [];
            proxyRes.on('data', (chunk) => {
                proxyReq.setTimeout(timeoutMs);
                responseChunks.push(chunk);
            });
            proxyRes.on('end', () => {
                if (settled)
                    return;
                settled = true;
                finalizeBufferedResponse(res, statusCode, proxyRes.headers, Buffer.concat(responseChunks), req.url || '/', transformBody);
            });
            proxyRes.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
                sendProxyError(res, 500, 'Proxy forwarding failed: ' + err.message);
            });
        }
        else {
            req.socket?.setNoDelay(true);
            res.socket?.setNoDelay(true);
            if (!res.headersSent) {
                res.writeHead(statusCode, proxyRes.headers);
                res.flushHeaders?.();
            }
            const contentType = String(proxyRes.headers['content-type'] || '');
            const sseEnabled = isGeneration && statusCode >= 200 && statusCode < 300 && contentType.includes('text/event-stream');
            sseKeepalive = createSseKeepaliveTracker(res, sseEnabled, sseKeepaliveMs);
            proxyRes.on('data', (chunk) => {
                proxyReq.setTimeout(timeoutMs);
                sseKeepalive?.onChunk(chunk);
            });
            proxyRes.on('end', () => {
                sseKeepalive?.stop();
                settled = true;
            });
            proxyRes.on('error', (err) => {
                sseKeepalive?.stop();
                settled = true;
                electron_log_1.default.error('[Proxy] Google Forwarding Stream Error:', err);
                if (!res.writableEnded)
                    res.end();
            });
            proxyRes.pipe(res);
        }
    });
    proxyReq.on('socket', (socket) => {
        socket.setKeepAlive(true, 5000);
    });
    proxyReq.setTimeout(timeoutMs, () => {
        if (settled)
            return;
        settled = true;
        sseKeepalive?.stop();
        electron_log_1.default.error(`[Proxy] Google proxy ${isGeneration ? 'generation' : 'metadata'} request timed out after ${timeoutMs / 1000}s`);
        proxyReq.destroy();
        sendProxyError(res, 504, 'Google API request timed out');
    });
    const onClientClose = () => {
        if (!res.writableEnded && !settled) {
            clientClosed = true;
            settled = true;
            sseKeepalive?.stop();
            proxyReq.destroy();
        }
    };
    res.once('close', onClientClose);
    proxyReq.on('error', (err) => {
        res.removeListener('close', onClientClose);
        if (settled || clientClosed)
            return;
        if (!headersReceived && !res.headersSent && attempt + 1 < MAX_RETRY_ATTEMPTS && isRetryablePreHeaderError(err)) {
            electron_log_1.default.warn(`[Proxy] Pre-header HTTP/1.1 error (${err.message}); retrying attempt ${attempt + 2}/${MAX_RETRY_ATTEMPTS}`);
            attemptHttp1Fallback(opts, parsedUrl, timeoutMs, attempt + 1);
            return;
        }
        settled = true;
        electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
        sendProxyError(res, 500, 'Proxy forwarding failed: ' + err.message);
    });
    if (reqBody.length > 0) {
        proxyReq.write(reqBody);
    }
    proxyReq.end();
}
function attemptHttp2Forward(opts, parsedUrl, timeoutMs, pingIntervalMs, warmIdleMs, attempt) {
    const { req, res, reqBody, isGeneration, shouldBufferAndModify, transformBody, http2ConnectOptions } = opts;
    const sseKeepaliveMs = opts.sseKeepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
    const origin = parsedUrl.origin;
    const entry = getOrCreateHttp2Session(origin, pingIntervalMs, warmIdleMs, http2ConnectOptions);
    const h2Headers = buildHttp2Headers(req.method || 'GET', parsedUrl, req.headers, reqBody, shouldBufferAndModify);
    let stream;
    try {
        stream = entry.session.request(h2Headers);
    }
    catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        retireSession(origin, entry);
        if (attempt + 1 < MAX_RETRY_ATTEMPTS && !res.headersSent) {
            electron_log_1.default.warn(`[Proxy] HTTP/2 request open failed (${error.message}); retrying attempt ${attempt + 2}/${MAX_RETRY_ATTEMPTS}`);
            attemptHttp2Forward(opts, parsedUrl, timeoutMs, pingIntervalMs, warmIdleMs, attempt + 1);
            return;
        }
        attemptHttp1Fallback(opts, parsedUrl, timeoutMs, attempt);
        return;
    }
    entry.activeStreams += 1;
    entry.lastActivityAt = Date.now();
    ensurePingTimer(entry, pingIntervalMs, warmIdleMs);
    let streamFinished = false;
    let headersReceived = false;
    let clientClosed = false;
    let sseKeepalive;
    const releaseStream = () => {
        if (streamFinished)
            return;
        streamFinished = true;
        sseKeepalive?.stop();
        entry.activeStreams = Math.max(0, entry.activeStreams - 1);
        entry.lastActivityAt = Date.now();
        res.removeListener('close', onClientClose);
    };
    const onClientClose = () => {
        if (!res.writableEnded && !streamFinished) {
            clientClosed = true;
            releaseStream();
            try {
                stream.close(http2.constants.NGHTTP2_CANCEL);
            }
            catch {
                stream.destroy();
            }
        }
    };
    res.once('close', onClientClose);
    stream.setTimeout(timeoutMs);
    stream.on('timeout', () => {
        if (streamFinished)
            return;
        releaseStream();
        electron_log_1.default.error(`[Proxy] Google proxy ${isGeneration ? 'generation' : 'metadata'} request timed out after ${timeoutMs / 1000}s`);
        try {
            stream.close(http2.constants.NGHTTP2_CANCEL);
        }
        catch {
            stream.destroy();
        }
        sendProxyError(res, 504, 'Google API request timed out');
    });
    const retryOrFail = (err) => {
        if (streamFinished || clientClosed)
            return;
        releaseStream();
        if (!headersReceived && !res.headersSent) {
            retireSession(origin, entry);
            if (attempt + 1 < MAX_RETRY_ATTEMPTS) {
                electron_log_1.default.warn(`[Proxy] HTTP/2 pre-header failure for ${origin} (${err.message}); retrying attempt ${attempt + 2}/${MAX_RETRY_ATTEMPTS}`);
                attemptHttp2Forward(opts, parsedUrl, timeoutMs, pingIntervalMs, warmIdleMs, attempt + 1);
                return;
            }
            electron_log_1.default.warn(`[Proxy] Falling back to HTTP/1.1 after HTTP/2 error (${err.message})`);
            attemptHttp1Fallback(opts, parsedUrl, timeoutMs, 0);
            return;
        }
        electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
        sendProxyError(res, 500, 'Proxy forwarding failed: ' + err.message);
    };
    stream.on('error', retryOrFail);
    stream.on('response', (resHeaders) => {
        if (streamFinished || clientClosed)
            return;
        headersReceived = true;
        const statusCode = Number(resHeaders[':status'] || 200);
        if (shouldBufferAndModify) {
            const responseChunks = [];
            stream.on('data', (chunk) => {
                stream.setTimeout(timeoutMs);
                responseChunks.push(chunk);
            });
            stream.on('end', () => {
                if (streamFinished)
                    return;
                releaseStream();
                finalizeBufferedResponse(res, statusCode, resHeaders, Buffer.concat(responseChunks), req.url || '/', transformBody);
            });
        }
        else {
            req.socket?.setNoDelay(true);
            res.socket?.setNoDelay(true);
            const outgoingHeaders = toOutgoingResponseHeaders(resHeaders);
            if (!res.headersSent) {
                res.writeHead(statusCode, outgoingHeaders);
                res.flushHeaders?.();
            }
            const contentType = String(resHeaders['content-type'] || '');
            const sseEnabled = isGeneration && statusCode >= 200 && statusCode < 300 && contentType.includes('text/event-stream');
            sseKeepalive = createSseKeepaliveTracker(res, sseEnabled, sseKeepaliveMs);
            stream.on('data', (chunk) => {
                stream.setTimeout(timeoutMs);
                sseKeepalive?.onChunk(chunk);
            });
            stream.on('end', () => {
                releaseStream();
            });
            stream.pipe(res);
        }
    });
    stream.on('close', () => {
        if (streamFinished || clientClosed)
            return;
        if (!headersReceived) {
            const rstCode = stream.rstCode;
            retryOrFail(new Error(`HTTP/2 stream closed before response headers (rstCode=${rstCode})`));
            return;
        }
        releaseStream();
    });
    if (reqBody.length > 0) {
        stream.write(reqBody);
    }
    stream.end();
}
function forwardToGoogle(opts) {
    const { req, targetHost, isGeneration } = opts;
    const protocol = targetHost.startsWith('http://') || targetHost.startsWith('https://') ? '' : 'https://';
    const parsedUrl = new URL(req.url || '/', `${protocol}${targetHost}`);
    const timeoutMs = isGeneration
        ? opts.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
        : opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const warmIdleMs = opts.warmIdleMs ?? DEFAULT_WARM_IDLE_MS;
    if (parsedUrl.protocol === 'http:') {
        attemptHttp1Fallback(opts, parsedUrl, timeoutMs, 0);
        return;
    }
    attemptHttp2Forward(opts, parsedUrl, timeoutMs, pingIntervalMs, warmIdleMs, 0);
}
function fetchViaHttp1Buffer(parsedUrl, opts, timeoutMs) {
    return new Promise((resolve, reject) => {
        const reqBody = opts.reqBody ?? Buffer.alloc(0);
        const headers = { ...(opts.headers || {}) };
        headers['host'] = parsedUrl.host;
        headers['accept-encoding'] = 'gzip';
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        if (reqBody.length > 0) {
            headers['content-length'] = String(reqBody.length);
        }
        const isHttps = parsedUrl.protocol === 'https:';
        let settled = false;
        const req = (isHttps ? https : http).request(parsedUrl, {
            method: opts.method || 'GET',
            headers: headers,
            agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
            ...buildSocketConnectOptions(),
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                const { body } = maybeGunzip(Buffer.concat(chunks), res.headers);
                resolve({ statusCode: res.statusCode || 200, headers: toOutgoingResponseHeaders(res.headers), body });
            });
            res.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            req.destroy(new Error(`Google request timed out after ${timeoutMs}ms`));
            reject(new Error(`Google request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        req.on('socket', (socket) => socket.setKeepAlive(true, 5000));
        req.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        if (reqBody.length > 0)
            req.write(reqBody);
        req.end();
    });
}
function fetchViaHttp2Buffer(parsedUrl, opts, timeoutMs, attempt) {
    return new Promise((resolve, reject) => {
        const reqBody = opts.reqBody ?? Buffer.alloc(0);
        const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        const warmIdleMs = opts.warmIdleMs ?? DEFAULT_WARM_IDLE_MS;
        const origin = parsedUrl.origin;
        const entry = getOrCreateHttp2Session(origin, pingIntervalMs, warmIdleMs, opts.http2ConnectOptions);
        const h2Headers = buildHttp2Headers(opts.method || 'GET', parsedUrl, opts.headers || {}, reqBody, true);
        let stream;
        try {
            stream = entry.session.request(h2Headers);
        }
        catch (err) {
            electron_log_1.default.warn(`[Proxy] HTTP/2 buffered request open failed for ${origin}:`, err);
            retireSession(origin, entry);
            if (attempt + 1 < MAX_RETRY_ATTEMPTS) {
                fetchViaHttp2Buffer(parsedUrl, opts, timeoutMs, attempt + 1).then(resolve, reject);
                return;
            }
            fetchViaHttp1Buffer(parsedUrl, opts, timeoutMs).then(resolve, reject);
            return;
        }
        entry.activeStreams += 1;
        entry.lastActivityAt = Date.now();
        ensurePingTimer(entry, pingIntervalMs, warmIdleMs);
        let settled = false;
        let headersReceived = false;
        const finish = () => {
            if (settled)
                return false;
            settled = true;
            clearTimeout(timer);
            entry.activeStreams = Math.max(0, entry.activeStreams - 1);
            entry.lastActivityAt = Date.now();
            return true;
        };
        const timer = setTimeout(() => {
            if (!finish())
                return;
            try {
                stream.close(http2.constants.NGHTTP2_CANCEL);
            }
            catch {
                stream.destroy();
            }
            reject(new Error(`Google request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const handleFailure = (err) => {
            if (!finish())
                return;
            if (!headersReceived) {
                retireSession(origin, entry);
                if (attempt + 1 < MAX_RETRY_ATTEMPTS) {
                    fetchViaHttp2Buffer(parsedUrl, opts, timeoutMs, attempt + 1).then(resolve, reject);
                    return;
                }
                fetchViaHttp1Buffer(parsedUrl, opts, timeoutMs).then(resolve, reject);
                return;
            }
            reject(err);
        };
        stream.on('error', handleFailure);
        stream.on('response', (resHeaders) => {
            headersReceived = true;
            const statusCode = Number(resHeaders[':status'] || 200);
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
                if (!finish())
                    return;
                const { body } = maybeGunzip(Buffer.concat(chunks), resHeaders);
                resolve({ statusCode, headers: toOutgoingResponseHeaders(resHeaders), body });
            });
        });
        stream.on('close', () => {
            if (!settled && !headersReceived) {
                handleFailure(new Error(`HTTP/2 stream closed before response headers (rstCode=${stream.rstCode})`));
            }
        });
        if (reqBody.length > 0)
            stream.write(reqBody);
        stream.end();
    });
}
/**
 * Fetches a buffered response from Google over the shared warm HTTP/2 pool
 * with pre-header timeout enforcement, gzip decompression, and HTTP/1.1 fallback.
 */
function fetchGoogleBuffer(opts) {
    const protocol = opts.targetHost.startsWith('http://') || opts.targetHost.startsWith('https://') ? '' : 'https://';
    const parsedUrl = new URL(opts.path || '/', `${protocol}${opts.targetHost}`);
    const timeoutMs = opts.timeoutMs ?? 5000;
    if (parsedUrl.protocol === 'http:') {
        return fetchViaHttp1Buffer(parsedUrl, opts, timeoutMs);
    }
    return fetchViaHttp2Buffer(parsedUrl, opts, timeoutMs, 0);
}
function stopGoogleForwarder() {
    for (const [origin, entry] of sessionPool.entries()) {
        retireSession(origin, entry);
    }
    sessionPool.clear();
    keepAliveHttpsAgent.destroy();
    keepAliveHttpAgent.destroy();
}
function getGoogleForwarderStats() {
    let totalActiveStreams = 0;
    for (const entry of sessionPool.values()) {
        totalActiveStreams += entry.activeStreams;
    }
    return {
        activeSessions: sessionPool.size,
        totalActiveStreams,
    };
}
//# sourceMappingURL=googleForwarder.js.map