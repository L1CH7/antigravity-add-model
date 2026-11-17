"use strict";
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
exports.getProxyMetrics = getProxyMetrics;
exports.stopCustomRequests = stopCustomRequests;
exports.runCustomModelRequest = runCustomModelRequest;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto_1 = require("crypto");
const string_decoder_1 = require("string_decoder");
const providers_1 = require("../providers");
const googleAccounts_1 = require("../googleAccounts");
const registry = __importStar(require("./registry"));
const circuitBreaker_1 = require("./circuitBreaker");
const requestOptions_1 = require("./requestOptions");
const modelUtils_1 = require("./modelUtils");
const shared_1 = require("./shared");
const utils_1 = require("./translators/utils");
const traceLog_1 = require("./traceLog");
const electron_log_1 = __importDefault(require("electron-log"));
const keepAliveHttpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 5000,
    maxSockets: 64,
    maxFreeSockets: 16,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 150,
});
const keepAliveHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 5000,
    maxSockets: 64,
    maxFreeSockets: 16,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 150,
});
const circuits = new circuitBreaker_1.CircuitBreaker();
const controllers = new Set();
const counts = {
    requests: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    upstreamAttempts: 0,
    retries: 0,
    circuitSkips: 0,
    accountSwitches: 0,
};
function getProxyMetrics() {
    return { ...counts, circuits: circuits.snapshot() };
}
function stopCustomRequests() {
    (0, traceLog_1.stopTraceCleanup)();
    for (const controller of controllers)
        controller.abort();
}
function createResponseTraceAcc() {
    return { text: '', reasoning: '', tools: [], emittedFinishReasons: [] };
}
function recordTraceCandidate(candidate, acc) {
    if (!candidate || typeof candidate !== 'object')
        return;
    const c = candidate;
    if (c.finishReason && !acc.emittedFinishReasons.includes(c.finishReason)) {
        acc.emittedFinishReasons.push(c.finishReason);
    }
    for (const part of c.content?.parts || []) {
        if (typeof part.text === 'string') {
            if (part.thought)
                acc.reasoning += part.text;
            else
                acc.text += part.text;
        }
        if (part.functionCall?.name) {
            let argsBytes = 0;
            try {
                argsBytes = Buffer.byteLength(JSON.stringify(part.functionCall.args ?? {}), 'utf8');
            }
            catch {
                argsBytes = 0;
            }
            acc.tools.push({
                name: part.functionCall.name,
                id: part.functionCall.id,
                args: part.functionCall.args ?? {},
                argsBytes,
            });
        }
    }
}
function snapshotBufferedContext(streamKey) {
    const ctx = shared_1.activeStreamContexts.get(streamKey);
    if (!ctx)
        return null;
    const pendingTools = Object.values(ctx.toolCalls || {}).filter((t) => Boolean(t.name || t.arguments));
    if (!ctx.accumulatedText && !ctx.accumulatedReasoning && pendingTools.length === 0)
        return null;
    return {
        accumulatedText: ctx.accumulatedText,
        accumulatedReasoning: ctx.accumulatedReasoning,
        toolCalls: pendingTools,
    };
}
function logOutboundPayloadSummary(displayName, format, payload, byteLen) {
    if (format === 'openai') {
        const msgs = Array.isArray(payload.messages) ? payload.messages : [];
        const tally = {};
        for (const msg of msgs) {
            if (msg.role === 'tool') {
                tally.tool = (tally.tool || 0) + 1;
                continue;
            }
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    const kind = part?.type || 'unknown';
                    tally[kind] = (tally[kind] || 0) + 1;
                }
            }
            else if (typeof msg.content === 'string' && msg.content) {
                tally.text = (tally.text || 0) + 1;
            }
        }
        electron_log_1.default.info(`[Proxy] Outbound "${displayName}" (${format}, msgs=${msgs.length}, parts=${JSON.stringify(tally)}, bytes=${byteLen ?? 0})`);
        return;
    }
    const contents = Array.isArray(payload.contents)
        ? payload.contents
        : [];
    const tally = {};
    for (const item of contents) {
        for (const part of item.parts || []) {
            if (part.text)
                tally.text = (tally.text || 0) + 1;
            if (part.inlineData || part.inline_data)
                tally.inlineData = (tally.inlineData || 0) + 1;
            if (part.fileData || part.file_data)
                tally.fileData = (tally.fileData || 0) + 1;
            const fnResp = part.functionResponse;
            if (fnResp) {
                tally.functionResponse = (tally.functionResponse || 0) + 1;
                if (Array.isArray(fnResp.parts) && fnResp.parts.length > 0) {
                    tally.fnParts = (tally.fnParts || 0) + fnResp.parts.length;
                }
            }
        }
    }
    electron_log_1.default.info(`[Proxy] Outbound "${displayName}" (${format}, contents=${contents.length}, parts=${JSON.stringify(tally)}, bytes=${byteLen ?? 0})`);
}
class UpstreamError extends Error {
    constructor(message, status = 502, retryable = true, retryAfter = 0, mayFallback = true) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.retryAfter = retryAfter;
        this.mayFallback = mayFallback;
    }
}
function asUpstreamError(error) {
    if (error instanceof googleAccounts_1.GoogleAccountError)
        return new UpstreamError(error.message, error.status, false);
    if (error instanceof UpstreamError)
        return error;
    const msg = error instanceof Error ? error.message : String(error);
    return new UpstreamError(`Upstream connection failed: ${msg}`);
}
function clearStreamState(streamKey) {
    shared_1.activeStreamContexts.delete(streamKey);
    shared_1.stateTimestamps.streamCtx.delete(streamKey);
}
function extractChunkMetadata(chunk, format) {
    const meta = {};
    if (format === 'google' && chunk.usageMetadata && typeof chunk.usageMetadata === 'object') {
        meta.usageMetadata = chunk.usageMetadata;
    }
    else {
        const usage = chunk.usage || chunk.message?.usage;
        if (usage && typeof usage === 'object') {
            const promptTokenCount = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
            const candidatesTokenCount = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
            const totalTokenCount = Number(usage.total_tokens ?? promptTokenCount + candidatesTokenCount);
            const cachedTokens = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
            meta.usageMetadata = {
                promptTokenCount,
                candidatesTokenCount,
                totalTokenCount,
                ...(cachedTokens > 0 ? { cachedContentTokenCount: cachedTokens } : {}),
            };
        }
        else if (chunk.usageMetadata && typeof chunk.usageMetadata === 'object') {
            meta.usageMetadata = chunk.usageMetadata;
        }
    }
    const modelVersion = chunk.modelVersion || chunk.model || chunk.message?.model;
    if (typeof modelVersion === 'string' && modelVersion)
        meta.modelVersion = modelVersion;
    const responseId = chunk.responseId || chunk.id || chunk.message?.id;
    if (typeof responseId === 'string' && responseId)
        meta.responseId = responseId;
    return meta;
}
function envelope(value, cloud) {
    return cloud ? { response: value, traceId: '', metadata: {} } : value;
}
function validateToolArguments(value) {
    let parsed = value;
    try {
        if (typeof value === 'string')
            parsed = JSON.parse(value || '{}');
    }
    catch {
        throw new UpstreamError('Upstream returned incomplete tool arguments.', 502, false, 0, false);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new UpstreamError('Upstream returned invalid tool arguments.', 502, false, 0, false);
}
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error('Cancelled'));
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
function waitForDrain(res) {
    if (!res.writableNeedDrain)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const drain = () => {
            res.removeListener('close', closed);
            resolve();
        };
        const closed = () => {
            res.removeListener('drain', drain);
            reject(new Error('Cancelled'));
        };
        res.once('drain', drain);
        res.once('close', closed);
    });
}
/** Известные коды ошибок апстрима и соответствующие HTTP-статусы. */
function statusFromUpstreamCode(code, fallback) {
    if (typeof code === 'number' && Number.isFinite(code))
        return code;
    if (typeof code !== 'string')
        return fallback;
    const known = {
        invalid_request: 400,
        invalid_request_error: 400,
        context_length_exceeded: 400,
        bad_request: 400,
        authentication_error: 401,
        invalid_api_key: 401,
        permission_error: 403,
        model_not_found: 404,
        not_found: 404,
        rate_limit: 429,
        rate_limit_error: 429,
        rate_limit_exceeded: 429,
        insufficient_quota: 429,
        overloaded_error: 503,
        api_error: 502,
    };
    return known[code] ?? fallback;
}
/** Извлекает код и сообщение ошибки из JSON-тела ответа апстрима. */
function extractErrorDetails(rawBody) {
    try {
        const parsed = JSON.parse(rawBody);
        return {
            code: parsed?.error?.code ?? parsed?.error?.type ?? parsed?.code,
            message: typeof parsed?.error?.message === 'string' ? parsed.error.message : typeof parsed?.message === 'string' ? parsed.message : undefined,
        };
    }
    catch {
        return {};
    }
}
/** Определяет отказ маршрутизации канала, который IDE не должна повторять 9 раз. */
function isPaidChannelUnavailableError(code, message) {
    return (code === 'upstream_unavailable' ||
        /smart_route_stream_commit_failure|No upstream channels are currently available/i.test(message));
}
/** Проверяет, содержит ли переведённый кандидат значимый ответ, мысль, вложение или вызов инструмента. */
function hasSubstantiveCandidateContent(mapped) {
    const parts = mapped?.content?.parts;
    if (!Array.isArray(parts))
        return false;
    return parts.some((rawPart) => {
        const part = rawPart;
        if (part.functionCall || part.thought || part.inlineData || part.executableCode || part.codeExecutionResult) {
            return true;
        }
        return typeof part.text === 'string' && part.text.trim().length > 0;
    });
}
/** The sole retry owner; the request never switches to another model or provider. */
async function runCustomModelRequest(res, primary, originalBody, isStream, cloudEnvelope = true) {
    const toolSchemas = (0, utils_1.collectToolSchemas)(originalBody);
    (0, traceLog_1.startTraceCleanup)();
    const controller = new AbortController();
    const { signal } = controller;
    const requestId = (0, crypto_1.randomUUID)();
    controllers.add(controller);
    counts.requests += 1;
    counts.active += 1;
    const onClose = () => {
        if (!res.writableEnded)
            controller.abort();
    };
    res.once('close', onClose);
    let completed = false;
    let upstreamOutput = false;
    const deadline = Date.now() + (primary.retryBudgetMs ?? Math.max(primary.timeout ?? 600000, 600000));
    let failure = new UpstreamError('No configured model is currently available.', 503);
    const writeStreamPayload = (payload) => {
        if (signal.aborted || res.destroyed)
            throw new Error('Cancelled');
        if (!res.headersSent) {
            res.socket?.setNoDelay(true);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            });
            res.flushHeaders?.();
        }
        res.write(`data: ${JSON.stringify(envelope(payload, cloudEnvelope))}\n\n`);
    };
    const writeCandidate = (candidate, meta) => {
        writeStreamPayload({ candidates: [candidate], ...(meta || {}) });
    };
    // Стабильный ключ диалога для сохранения reasoning_content и tool_call_id между ходами.
    const rawConvId = originalBody.conversationId || originalBody.sessionId;
    const conversationKey = typeof rawConvId === 'string' && rawConvId.trim()
        ? `${primary.name}:${rawConvId.trim()}`
        : primary.name || primary.externalModelName || 'custom-model';
    try {
        modelBlock: {
            const model = primary;
            if (signal.aborted)
                return;
            if (Date.now() >= deadline) {
                failure = new UpstreamError('Request retry budget exhausted.', 504, false);
                res.writeHead(failure.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: failure.message, code: failure.status, upstreamStatus: failure.status } }));
                return;
            }
            // Include transport configuration so editing a broken endpoint does not retain its open circuit.
            const circuitKey = JSON.stringify([model.name, model.apiUrl, model.apiFormat || model.provider]);
            if (!circuits.acquire(circuitKey, model.circuitBreaker)) {
                counts.circuitSkips += 1;
                failure = new UpstreamError('Model circuit is open after repeated upstream failures.', 503, false);
                res.writeHead(failure.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: failure.message, code: failure.status, upstreamStatus: failure.status } }));
                return;
            }
            let modelFailed = false;
            const retries = Math.min(5, Math.max(0, model.maxRetries ?? 3));
            const cloudCode = model.provider === 'google-cloudcode';
            const accountCount = cloudCode
                ? (model.googleAccounts || []).filter((account) => account.enabled !== false).length
                : 0;
            const attemptsAllowed = retries + Math.max(0, accountCount - 1);
            const format = (0, providers_1.resolveApiFormat)(model.provider, model.apiFormat);
            const externalName = model.externalModelName || model.name.replace(/^models\//, '');
            // Готовим тримминг, трансляцию, URL и общие заголовки один раз до цикла повторов.
            let basePayload;
            let baseUrl;
            let baseHeaders;
            let staticBodyBuffer;
            try {
                const requestedMaxOutput = Number(originalBody.generationConfig?.maxOutputTokens || 0);
                const outputBudget = model.maxOutputTokens ??
                    (requestedMaxOutput > 0
                        ? requestedMaxOutput
                        : model.contextWindow
                            ? Math.min(modelUtils_1.DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(model.contextWindow / 4)))
                            : 0);
                const body = (0, requestOptions_1.trimContext)(originalBody, model.contextWindow, outputBudget);
                basePayload = (0, requestOptions_1.applyRequestOptions)(registry.translateRequest(model.provider, body, externalName, format, conversationKey), model, format, isStream);
                const target = cloudCode || model.rawUrl
                    ? model.apiUrl
                    : registry.getProviderUrl(model.apiUrl, externalName, isStream, registry.getTranslator(model.provider, format));
                baseUrl = new URL(target);
                if (!['http:', 'https:'].includes(baseUrl.protocol))
                    throw new Error('Unsupported endpoint protocol');
                baseHeaders = registry.getProviderHeaders(model.provider, cloudCode ? '' : model.apiKey, format);
                if (['opencode', 'zen', 'opencode-go'].includes(model.provider)) {
                    const identity = originalBody.sessionId || originalBody.conversationId;
                    baseHeaders['x-opencode-session'] = typeof identity === 'string' ? identity : requestId;
                }
                if (model.gateway) {
                    const identity = originalBody.conversationId || originalBody.sessionId;
                    if (typeof identity === 'string' && identity.trim()) {
                        // Stable across turns and safe as a header, even when callers use Unicode/control characters.
                        baseHeaders['x-antigravity-conversation-id'] = (0, crypto_1.createHash)('sha256').update(identity).digest('hex');
                    }
                }
                for (const [key, value] of Object.entries(model.customHeaders || {})) {
                    if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
                        throw new Error('Reserved HTTP header');
                    if (cloudCode && /^authorization$/i.test(key))
                        throw new Error('Google pool authorization comes from the selected account');
                    http.validateHeaderName(key);
                    http.validateHeaderValue(key, value);
                    baseHeaders[key] = value;
                }
                if (!cloudCode) {
                    staticBodyBuffer = Buffer.from(JSON.stringify(basePayload), 'utf8');
                }
                logOutboundPayloadSummary(model.displayName, format, basePayload, staticBodyBuffer?.length);
            }
            catch (error) {
                failure = new UpstreamError(`Invalid model configuration: ${error.message}`, 400, false, 0, false);
                circuits.cancel(circuitKey);
                break modelBlock;
            }
            for (let attempt = 0; attempt <= attemptsAllowed; attempt++) {
                const streamKey = (0, crypto_1.randomUUID)();
                const attemptStart = Date.now();
                const traceAcc = createResponseTraceAcc();
                const rawFinishReasons = [];
                let rawUsage = undefined;
                let recoveredRemainder = false;
                let receivedChunks = 0;
                let receivedBytes = 0;
                let firstContentAt = 0;
                let firstReasoningAt = 0;
                let request;
                let accountLease;
                let totalTimer;
                let heartbeatTimer;
                const abort = () => request?.destroy(new Error('Cancelled'));
                try {
                    if (signal.aborted)
                        break;
                    const remaining = deadline - Date.now();
                    if (remaining <= 0)
                        throw new UpstreamError('Request retry budget exhausted.', 504, false);
                    let url = baseUrl;
                    let headers = baseHeaders;
                    let bodyBuffer = staticBodyBuffer;
                    let tracePayloadObj = basePayload;
                    if (cloudCode) {
                        const identity = originalBody.sessionId || originalBody.conversationId;
                        accountLease = await (0, googleAccounts_1.acquireGoogleAccount)(model.name, model.googleAccounts || [], model.googlePool, typeof identity === 'string' ? identity : undefined);
                        if (signal.aborted)
                            break;
                        url = new URL(baseUrl.toString());
                        url.pathname = `/v1internal:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
                        url.search = isStream ? '?alt=sse' : '';
                        headers = { ...baseHeaders, Authorization: `Bearer ${accountLease.account.accessToken}` };
                        if (!headers['User-Agent'] && !headers['user-agent']) {
                            headers['User-Agent'] = 'antigravity';
                        }
                        const project = accountLease.account.project || model.googleProject;
                        const envelopePayload = { model: externalName, ...(project ? { project } : {}), request: basePayload };
                        tracePayloadObj = envelopePayload;
                        bodyBuffer = Buffer.from(JSON.stringify(envelopePayload), 'utf8');
                    }
                    (0, traceLog_1.writeTraceEvent)({
                        phase: 'request',
                        requestId,
                        conversationKey,
                        model: model.name,
                        externalModel: externalName,
                        displayName: model.displayName,
                        provider: model.provider,
                        format,
                        attempt: attempt + 1,
                        stream: isStream,
                        url: url.toString(),
                        headers: (0, traceLog_1.sanitizeTraceHeaders)(headers),
                        payload: (0, traceLog_1.sanitizeTracePayload)(tracePayloadObj),
                    });
                    counts.upstreamAttempts += 1;
                    const upstream = await new Promise((resolve, reject) => {
                        request = (url.protocol === 'https:' ? https : http).request(url, {
                            method: 'POST',
                            headers,
                            rejectUnauthorized: !model.allowUnauthorized,
                            agent: url.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent,
                        }, resolve);
                        request.once('socket', (socket) => {
                            socket.setNoDelay(true);
                            socket.setKeepAlive(true, 5000);
                        });
                        request.once('error', (err) => {
                            if (signal.aborted && err.message === 'Cancelled') {
                                electron_log_1.default.info(`[Proxy] Request cancelled by client for "${model.displayName}" (${url.toString()})`);
                            }
                            else {
                                electron_log_1.default.error(`[Proxy] Socket error for "${model.displayName}" (${url.toString()}):`, err);
                            }
                            reject(err);
                        });
                        request.setTimeout(model.idleTimeout ?? 300000, () => request?.destroy(new UpstreamError('Upstream idle timeout.', 504)));
                        totalTimer = setTimeout(() => request?.destroy(new UpstreamError('Upstream request timeout.', 504)), Math.min(model.timeout ?? 600000, remaining));
                        signal.addEventListener('abort', abort, { once: true });
                        request.end(bodyBuffer);
                    });
                    const status = upstream.statusCode || 502;
                    if (status < 200 || status >= 300) {
                        const retryAfter = (0, requestOptions_1.parseRetryAfter)(upstream.headers['retry-after']);
                        const errorChunks = [];
                        for await (const chunk of upstream) {
                            errorChunks.push(chunk);
                            if (errorChunks.reduce((acc, c) => acc + c.length, 0) > 1048576)
                                break;
                        }
                        const errorBody = Buffer.concat(errorChunks).toString('utf-8');
                        electron_log_1.default.error(`[Proxy] Upstream HTTP ${status} for "${model.displayName}" (${url}) [attempt ${attempt + 1}/${attemptsAllowed + 1}], body bytes ${errorBody.length}: ${errorBody}`);
                        upstream.destroy();
                        const parsedErr = extractErrorDetails(errorBody);
                        const effectiveStatus = statusFromUpstreamCode(parsedErr.code, status);
                        const paidUnavailable = isPaidChannelUnavailableError(parsedErr.code, parsedErr.message || errorBody);
                        const error = new UpstreamError(errorBody || `Upstream returned HTTP ${status}.`, effectiveStatus, effectiveStatus === 408 || effectiveStatus === 429 || effectiveStatus >= 500, retryAfter, effectiveStatus !== 400 && effectiveStatus !== 404 && effectiveStatus !== 422);
                        error.upstreamBody = errorBody;
                        error.upstreamStatus = status;
                        if (paidUnavailable)
                            error.clientStatus = 424;
                        throw error;
                    }
                    if (isStream && String(upstream.headers['content-type']).includes('text/event-stream')) {
                        const decoder = new string_decoder_1.StringDecoder('utf8');
                        let buffer = '';
                        let dataLines = [];
                        let emitted = false;
                        let hasVisibleContent = false;
                        let hasSubstantiveOutput = false;
                        const pendingWhitespace = [];
                        let finalReason = false;
                        let terminal = false;
                        let pendingMeta = null;
                        let usageEmitted = false;
                        const emitCandidate = (candidate, meta) => {
                            recordTraceCandidate(candidate, traceAcc);
                            writeCandidate(candidate, meta);
                        };
                        const flushWhitespace = () => {
                            while (pendingWhitespace.length > 0) {
                                const item = pendingWhitespace.shift();
                                if (item.meta?.usageMetadata)
                                    usageEmitted = true;
                                emitCandidate(item.candidate, item.meta);
                            }
                        };
                        let streamDurationMs = 0;
                        heartbeatTimer = setInterval(() => {
                            streamDurationMs += 15000;
                            if (res.destroyed || res.writableEnded)
                                return;
                            if (res.headersSent) {
                                // Send keepalive newlines to reset Go client's idleTimeoutReadCloser (5m deadline)
                                res.write('\n\n');
                            }
                            else if (streamDurationMs >= 90000) {
                                // If upstream has been silent for >90s, commit SSE headers and start keepalive
                                res.writeHead(200, {
                                    'Content-Type': 'text/event-stream',
                                    'Cache-Control': 'no-cache',
                                    'X-Accel-Buffering': 'no',
                                });
                                res.write('\n\n');
                            }
                        }, 15000);
                        const event = () => {
                            const data = dataLines.join('\n');
                            dataLines = [];
                            if (!data)
                                return;
                            if (data.trim() === '[DONE]') {
                                terminal = true;
                                return;
                            }
                            let chunk;
                            try {
                                chunk = JSON.parse(data);
                            }
                            catch {
                                throw new UpstreamError('Upstream sent malformed SSE JSON.');
                            }
                            if (chunk.error || chunk.type === 'error') {
                                const errObj = chunk.error && typeof chunk.error === 'object' ? chunk.error : {};
                                const message = errObj.message ||
                                    chunk.message ||
                                    (typeof chunk.error === 'string' ? chunk.error : 'Upstream reported a stream error.');
                                const errCode = errObj.code ?? errObj.type;
                                const code = statusFromUpstreamCode(errCode, 502);
                                const paidUnavailable = isPaidChannelUnavailableError(errCode, message);
                                electron_log_1.default.error(`[Proxy] Upstream stream error for "${model.displayName}": status ${code}, after ${Date.now() - attemptStart}ms, received chunks ${receivedChunks}, bytes ${receivedBytes}, visibleContent ${hasVisibleContent}, terminal ${terminal}`, { error: chunk.error || chunk });
                                const error = new UpstreamError(message, code, paidUnavailable, 0, !paidUnavailable);
                                error.upstreamBody = data;
                                error.upstreamStatus = code;
                                if (paidUnavailable)
                                    error.clientStatus = 424;
                                throw error;
                            }
                            if (cloudCode && chunk.response)
                                chunk = chunk.response;
                            receivedChunks += 1;
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.reasoning_content || delta?.reasoning || chunk.delta?.thinking) {
                                if (!firstReasoningAt)
                                    firstReasoningAt = Date.now() - attemptStart;
                            }
                            const chunkMeta = extractChunkMetadata(chunk, format);
                            if (chunk.usage || chunk.usageMetadata || chunk.message?.usage) {
                                rawUsage = chunk.usage ?? chunk.usageMetadata ?? chunk.message?.usage;
                            }
                            if (chunkMeta.usageMetadata) {
                                pendingMeta = chunkMeta;
                            }
                            const candidateParts = chunk.candidates?.[0]?.content?.parts;
                            const hasVisibleCandidatePart = Array.isArray(candidateParts) &&
                                candidateParts.some((p) => (typeof p.text === 'string' && !p.thought && p.text.trim().length > 0) || Boolean(p.functionCall));
                            // Не помечаем поток как давший видимый вывод, пока не придёт непробельный контент или вызов инструмента.
                            if ((typeof delta?.content === 'string' && delta.content.trim().length > 0) ||
                                delta?.tool_calls?.length ||
                                chunk.content_block?.type === 'tool_use' ||
                                (typeof chunk.delta?.text === 'string' && chunk.delta.text.trim().length > 0) ||
                                chunk.delta?.partial_json ||
                                hasVisibleCandidatePart)
                                upstreamOutput = true;
                            const candidateFinishReason = chunk.candidates?.[0]?.finishReason;
                            const upstreamFinish = chunk.choices?.[0]?.finish_reason ||
                                (chunk.type === 'message_delta' ? chunk.delta?.stop_reason : undefined) ||
                                (candidateFinishReason && candidateFinishReason !== 'FINISH_REASON_UNSPECIFIED'
                                    ? candidateFinishReason
                                    : undefined);
                            if (upstreamFinish && !rawFinishReasons.includes(String(upstreamFinish))) {
                                rawFinishReasons.push(String(upstreamFinish));
                            }
                            if (chunk.type === 'message_stop' ||
                                chunk.choices?.[0]?.finish_reason ||
                                (candidateFinishReason && candidateFinishReason !== 'FINISH_REASON_UNSPECIFIED'))
                                terminal = true;
                            if ((chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'tool_use') ||
                                chunk.choices?.[0]?.finish_reason) {
                                for (const tool of Object.values(shared_1.activeStreamContexts.get(streamKey)?.toolCalls || {}))
                                    validateToolArguments(tool.arguments);
                            }
                            const mapped = registry.translateStreamChunk(model.provider, chunk, conversationKey, format, streamKey, toolSchemas);
                            if (mapped) {
                                const isTerminalFinish = Boolean(mapped.finishReason &&
                                    mapped.finishReason !== 'OTHER' &&
                                    mapped.finishReason !== 'FINISH_REASON_UNSPECIFIED');
                                if (mapped.content?.parts?.length) {
                                    emitted = true;
                                    for (const part of mapped.content.parts) {
                                        if ((typeof part.text === 'string' && !part.thought && (part.text.trim().length > 0 || hasSubstantiveOutput)) ||
                                            part.functionCall) {
                                            hasVisibleContent = true;
                                            if (!firstContentAt)
                                                firstContentAt = Date.now() - attemptStart;
                                        }
                                    }
                                }
                                if (isTerminalFinish)
                                    finalReason = true;
                                const emitMeta = Object.keys(chunkMeta).length > 0 ? chunkMeta : undefined;
                                if (!hasSubstantiveOutput && mapped.content?.parts?.length && !hasSubstantiveCandidateContent(mapped) && !isTerminalFinish) {
                                    // Придерживаем чисто пробельные стартовые чанки до первого значимого ответа или завершения потока.
                                    pendingWhitespace.push({ candidate: mapped, meta: emitMeta });
                                }
                                else {
                                    if (hasSubstantiveCandidateContent(mapped) || isTerminalFinish) {
                                        hasSubstantiveOutput = true;
                                        flushWhitespace();
                                    }
                                    // A role-only or empty completion must not commit headers and prevent fallback.
                                    if (emitted && hasSubstantiveOutput) {
                                        if (emitMeta?.usageMetadata)
                                            usageEmitted = true;
                                        emitCandidate(mapped, emitMeta);
                                    }
                                }
                            }
                            else if (pendingMeta?.usageMetadata && res.headersSent && terminal) {
                                usageEmitted = true;
                                writeStreamPayload({ candidates: [], ...pendingMeta });
                            }
                        };
                        const drain = () => {
                            let cursor = 0;
                            let index;
                            while ((index = buffer.indexOf('\n', cursor)) >= 0) {
                                const lineEnd = index > cursor && buffer.charCodeAt(index - 1) === 0x0d ? index - 1 : index;
                                const line = buffer.slice(cursor, lineEnd);
                                cursor = index + 1;
                                if (!line)
                                    event();
                                else if (line.startsWith('data:'))
                                    dataLines.push(line.slice(5).replace(/^ /, ''));
                            }
                            if (cursor > 0)
                                buffer = buffer.slice(cursor);
                        };
                        for await (const bytes of upstream) {
                            if (signal.aborted)
                                throw new Error('Cancelled');
                            receivedBytes += bytes.length;
                            buffer += decoder.write(bytes);
                            if (buffer.length + dataLines.join('').length > 2 * 1024 * 1024)
                                throw new UpstreamError('Upstream SSE event is too large.', 502, false);
                            drain();
                            await waitForDrain(res);
                        }
                        buffer += decoder.end();
                        if (buffer)
                            buffer += '\n';
                        drain();
                        event();
                        if (heartbeatTimer) {
                            clearInterval(heartbeatTimer);
                            heartbeatTimer = undefined;
                        }
                        if (!finalReason) {
                            const remainder = registry.flushStreamRemainder(model.provider, model.apiFormat, streamKey, conversationKey, toolSchemas);
                            if (remainder) {
                                for (const part of remainder.content?.parts || []) {
                                    if (part.functionCall)
                                        validateToolArguments(part.functionCall.args);
                                }
                                recoveredRemainder = true;
                                emitted = true;
                                hasVisibleContent = true;
                                hasSubstantiveOutput = true;
                                upstreamOutput = true;
                                finalReason = true;
                                if (!firstContentAt)
                                    firstContentAt = Date.now() - attemptStart;
                                flushWhitespace();
                                const tailMeta = !usageEmitted && pendingMeta ? pendingMeta : undefined;
                                if (tailMeta?.usageMetadata)
                                    usageEmitted = true;
                                emitCandidate(remainder, tailMeta);
                                electron_log_1.default.warn(`[Proxy] Flushed buffered stream remainder at end of SSE for "${model.displayName}" (upstreamFinish=${JSON.stringify(rawFinishReasons)})`);
                            }
                        }
                        if (!emitted)
                            throw new UpstreamError('Upstream returned an empty stream.');
                        if (!terminal)
                            throw new UpstreamError('Upstream stream ended before completion.', 502, false);
                        if (!hasVisibleContent && !finalReason) {
                            const error = new UpstreamError(`Upstream finished without visible content after ${Date.now() - attemptStart}ms (chunks ${receivedChunks}, bytes ${receivedBytes}, reasoning at ${firstReasoningAt || 'never'}).`, 502, false, 0, false);
                            error.upstreamStatus = 502;
                            throw error;
                        }
                        if (!finalReason) {
                            const tailMeta = !usageEmitted && pendingMeta ? pendingMeta : undefined;
                            if (tailMeta?.usageMetadata)
                                usageEmitted = true;
                            emitCandidate({ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }, tailMeta);
                        }
                        else if (!usageEmitted && pendingMeta?.usageMetadata && res.headersSent) {
                            usageEmitted = true;
                            writeStreamPayload({ candidates: [], ...pendingMeta });
                        }
                        const leftoverBuffer = snapshotBufferedContext(streamKey);
                        const completedDurationMs = Date.now() - attemptStart;
                        const toolSummary = traceAcc.tools.map((t) => `${t.name}(${t.argsBytes}b)`);
                        electron_log_1.default.info(`[Proxy] Completed "${model.displayName}" (${format}, status=200, dur=${completedDurationMs}ms, chunks=${receivedChunks}, bytes=${receivedBytes}, upstreamFinish=${JSON.stringify(rawFinishReasons)}, emittedFinish=${JSON.stringify(traceAcc.emittedFinishReasons)}, tools=${JSON.stringify(toolSummary)}, usage=${JSON.stringify(rawUsage ?? pendingMeta?.usageMetadata ?? null)})`);
                        (0, traceLog_1.writeTraceEvent)({
                            phase: 'stream_end',
                            requestId,
                            conversationKey,
                            model: model.name,
                            displayName: model.displayName,
                            provider: model.provider,
                            format,
                            attempt: attempt + 1,
                            status,
                            durationMs: completedDurationMs,
                            firstReasoningAtMs: firstReasoningAt || null,
                            firstContentAtMs: firstContentAt || null,
                            receivedChunks,
                            receivedBytes,
                            recoveredRemainder,
                            rawFinishReasons,
                            emittedFinishReasons: traceAcc.emittedFinishReasons,
                            text: traceAcc.text,
                            reasoning: traceAcc.reasoning,
                            tools: traceAcc.tools,
                            usageMetadata: pendingMeta?.usageMetadata ?? null,
                            rawUsage: rawUsage ?? null,
                            leftoverBuffer,
                        });
                    }
                    else {
                        let size = 0;
                        const chunks = [];
                        for await (const bytes of upstream) {
                            size += bytes.length;
                            if (size > 20 * 1024 * 1024)
                                throw new UpstreamError('Upstream response exceeds 20 MB.', 502, false);
                            chunks.push(bytes);
                        }
                        const rawBody = Buffer.concat(chunks).toString('utf8');
                        let parsed;
                        try {
                            parsed = JSON.parse(rawBody);
                        }
                        catch {
                            const error = new UpstreamError('Upstream returned invalid JSON.', 502, false, 0, false);
                            error.upstreamBody = rawBody;
                            error.upstreamStatus = 502;
                            throw error;
                        }
                        if (parsed.error) {
                            const errObj = typeof parsed.error === 'object' ? parsed.error : {};
                            const errCode = errObj.code ?? errObj.type;
                            const code = statusFromUpstreamCode(errCode, 502);
                            const message = errObj.message || (typeof parsed.error === 'string' ? parsed.error : 'Upstream returned an error response.');
                            const paidUnavailable = isPaidChannelUnavailableError(errCode, message);
                            const error = new UpstreamError(message, code, paidUnavailable, 0, !paidUnavailable);
                            error.upstreamBody = rawBody;
                            error.upstreamStatus = code;
                            if (paidUnavailable)
                                error.clientStatus = 424;
                            electron_log_1.default.error(`[Proxy] Upstream completion error for "${model.displayName}": status ${code}, after ${Date.now() - attemptStart}ms, body ${rawBody}`);
                            throw error;
                        }
                        if (cloudCode && parsed.response)
                            parsed = parsed.response;
                        if ((format === 'openai' && !parsed.choices?.[0]?.message) ||
                            (format === 'anthropic' && !Array.isArray(parsed.content)))
                            throw new UpstreamError('Upstream returned an invalid completion.');
                        if (parsed.choices?.[0]?.message?.tool_calls?.length) {
                            upstreamOutput = true;
                            for (const tool of parsed.choices[0].message.tool_calls)
                                validateToolArguments(tool.function?.arguments);
                        }
                        // Some compatible endpoints return a complete JSON response even when stream=true.
                        const nonStreamFinish = parsed.choices?.[0]?.finish_reason ||
                            parsed.stop_reason ||
                            parsed.candidates?.[0]?.finishReason;
                        if (nonStreamFinish)
                            rawFinishReasons.push(String(nonStreamFinish));
                        rawUsage = parsed.usage ?? parsed.usageMetadata;
                        const mapped = registry.translateResponse(model.provider, parsed, conversationKey, format, toolSchemas);
                        if (!mapped?.candidates?.length)
                            throw new UpstreamError('Upstream returned no candidates.');
                        for (const candidate of mapped.candidates)
                            recordTraceCandidate(candidate, traceAcc);
                        const respDurationMs = Date.now() - attemptStart;
                        const toolSummary = traceAcc.tools.map((t) => `${t.name}(${t.argsBytes}b)`);
                        electron_log_1.default.info(`[Proxy] Completed "${model.displayName}" (${format}, status=200, nonStream=true, dur=${respDurationMs}ms, upstreamFinish=${JSON.stringify(rawFinishReasons)}, emittedFinish=${JSON.stringify(traceAcc.emittedFinishReasons)}, tools=${JSON.stringify(toolSummary)}, usage=${JSON.stringify(rawUsage ?? mapped.usageMetadata ?? null)})`);
                        (0, traceLog_1.writeTraceEvent)({
                            phase: 'response',
                            requestId,
                            conversationKey,
                            model: model.name,
                            displayName: model.displayName,
                            provider: model.provider,
                            format,
                            attempt: attempt + 1,
                            status,
                            durationMs: respDurationMs,
                            rawFinishReasons,
                            emittedFinishReasons: traceAcc.emittedFinishReasons,
                            text: traceAcc.text,
                            reasoning: traceAcc.reasoning,
                            tools: traceAcc.tools,
                            usageMetadata: mapped.usageMetadata ?? null,
                            rawUsage: rawUsage ?? null,
                        });
                        if (isStream) {
                            for (const candidate of mapped.candidates)
                                writeCandidate(candidate);
                        }
                        else {
                            res.socket?.setNoDelay(true);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(envelope(mapped, cloudEnvelope)));
                        }
                    }
                    circuits.succeed(circuitKey);
                    completed = true;
                    counts.succeeded += 1;
                    res.end();
                    return;
                }
                catch (error) {
                    failure = asUpstreamError(error);
                    (0, traceLog_1.writeTraceEvent)({
                        phase: 'error',
                        requestId,
                        conversationKey,
                        model: model.name,
                        displayName: model.displayName,
                        provider: model.provider,
                        format,
                        attempt: attempt + 1,
                        status: failure.status,
                        upstreamStatus: failure.upstreamStatus ?? null,
                        durationMs: Date.now() - attemptStart,
                        receivedChunks,
                        receivedBytes,
                        rawFinishReasons,
                        errorMessage: failure.message,
                        upstreamBody: failure.upstreamBody ?? null,
                        partialText: traceAcc.text || null,
                        partialReasoning: traceAcc.reasoning || null,
                        partialTools: traceAcc.tools,
                        leftoverBuffer: snapshotBufferedContext(streamKey),
                    });
                    electron_log_1.default.warn(`[Proxy] Request attempt ${attempt + 1}/${attemptsAllowed + 1} for "${model.displayName}" failed after ${Date.now() - attemptStart}ms: ${failure.message}`);
                    accountLease?.release({ status: failure.status, retryAfterMs: failure.retryAfter });
                    if (signal.aborted) {
                        circuits.cancel(circuitKey);
                        break modelBlock;
                    }
                    if (res.headersSent || upstreamOutput) {
                        circuits.fail(circuitKey, model.circuitBreaker);
                        break modelBlock;
                    }
                    if (accountLease &&
                        attempt < accountCount - 1 &&
                        [401, 403, 408, 429, 500, 502, 503, 504].includes(failure.status)) {
                        counts.accountSwitches += 1;
                        continue;
                    }
                    if (failure.retryable && attempt < retries && Date.now() < deadline) {
                        counts.retries += 1;
                        // Tear down the old attempt before waiting; timeout and error cannot each schedule a retry.
                        request?.destroy();
                        if (totalTimer)
                            clearTimeout(totalTimer);
                        signal.removeEventListener('abort', abort);
                        await delay(Math.min(failure.retryAfter || 500 * 2 ** attempt, Math.max(1, deadline - Date.now())), signal);
                    }
                    else {
                        modelFailed = true;
                        break;
                    }
                }
                finally {
                    if (heartbeatTimer)
                        clearInterval(heartbeatTimer);
                    if (totalTimer)
                        clearTimeout(totalTimer);
                    signal.removeEventListener('abort', abort);
                    request?.destroy();
                    accountLease?.release();
                    clearStreamState(streamKey);
                }
            }
            if (modelFailed)
                circuits.fail(circuitKey, model.circuitBreaker);
            else
                circuits.cancel(circuitKey);
        }
        if (!signal.aborted && !res.writableEnded && !res.destroyed) {
            if (res.headersSent) {
                const errorPayload = {
                    error: {
                        code: failure.status || 500,
                        message: failure.message || 'Stream processing failed',
                        status: failure.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL',
                        upstreamStatus: failure.upstreamStatus ?? failure.status,
                        upstreamBody: failure.upstreamBody,
                    },
                };
                res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
                res.end();
            }
            else {
                const clientStatus = failure.clientStatus ?? failure.status;
                res.writeHead(clientStatus, { 'Content-Type': 'application/json' });
                res.write(JSON.stringify({
                    error: {
                        message: failure.message,
                        code: clientStatus,
                        upstreamStatus: failure.upstreamStatus ?? failure.status,
                        upstreamBody: failure.upstreamBody,
                    },
                }));
                res.end();
            }
        }
    }
    catch {
        if (!signal.aborted && !res.writableEnded && !res.destroyed) {
            if (res.headersSent) {
                res.end();
            }
            else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: `Model request failed for "${primary.displayName}".`,
                        code: 502,
                        upstreamStatus: 502,
                    },
                }));
            }
        }
    }
    finally {
        res.removeListener('close', onClose);
        controllers.delete(controller);
        counts.active -= 1;
        if (!completed) {
            if (signal.aborted)
                counts.cancelled += 1;
            else
                counts.failed += 1;
        }
    }
}
//# sourceMappingURL=customRequest.js.map