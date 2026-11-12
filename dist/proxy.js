"use strict";
/**
 * Antigravity Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom provider endpoints.
 * Intercepts model lists to inject user-defined custom models.
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
exports.isNativeGoogleModelName = exports.NATIVE_GOOGLE_MODELS = void 0;
exports.generateModelPlaceholderId = generateModelPlaceholderId;
exports.toSlug = toSlug;
exports.collectOccupiedPlaceholders = collectOccupiedPlaceholders;
exports.resolveCustomModelKeys = resolveCustomModelKeys;
exports.mergeFetchAvailableModelsResponse = mergeFetchAvailableModelsResponse;
exports.mergeListModelsResponse = mergeListModelsResponse;
exports.findMatchedCustomModel = findMatchedCustomModel;
exports.startProxy = startProxy;
exports.stopProxy = stopProxy;
exports.getProxyPort = getProxyPort;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const electron_1 = require("electron");
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Imports ──────────────────────────────────────────────────────────────
let server = null;
let proxyPort = 0;
let startingProxy = null;
let stoppingProxy = null;
// Shared cross-turn state
const shared_1 = require("./proxy/shared");
// Model configuration & capability detection
const modelUtils_1 = require("./proxy/modelUtils");
var modelUtils_2 = require("./proxy/modelUtils");
Object.defineProperty(exports, "NATIVE_GOOGLE_MODELS", { enumerable: true, get: function () { return modelUtils_2.NATIVE_GOOGLE_MODELS; } });
Object.defineProperty(exports, "isNativeGoogleModelName", { enumerable: true, get: function () { return modelUtils_2.isNativeGoogleModelName; } });
// Custom request transport and model storage
const customRequest_1 = require("./proxy/customRequest");
const modelStore_1 = require("./modelStore");
const listen_1 = require("./proxy/listen");
const cryptoStore = __importStar(require("./cryptoStore"));
// ─── Model Helpers ────────────────────────────────────────────────────────
function getCustomModelsPath() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(homeDir, ".gemini", "antigravity", "custom_models.json");
}
// Допустимый диапазон enum exa.codeium_common_pb.Model в language_server и main.js: MODEL_PLACEHOLDER_M0..M1650.
const VALID_PLACEHOLDER_MIN = 0;
const VALID_PLACEHOLDER_MAX = 1650;
// Верхний поддиапазон (M1000..M1650) удален от основных моделей Google; при занятости перебираем весь [0..1650].
const PREFERRED_PLACEHOLDER_MIN = 1000;
const PREFERRED_PLACEHOLDER_SPAN = VALID_PLACEHOLDER_MAX - PREFERRED_PLACEHOLDER_MIN + 1;
function generateModelPlaceholderId(model) {
    const ext = (model.externalModelName || model.name || "custom").toLowerCase();
    const disp = (model.displayName || "model").toLowerCase();
    let h1 = 5381;
    for (let i = 0; i < ext.length; i++)
        h1 = ((h1 << 5) + h1 + ext.charCodeAt(i)) & 0xFFFFFFFF;
    let h2 = 5381;
    for (let i = 0; i < disp.length; i++)
        h2 = ((h2 << 5) + h2 + disp.charCodeAt(i)) & 0xFFFFFFFF;
    const num = PREFERRED_PLACEHOLDER_MIN + (Math.abs((h1 * 7) + h2) % PREFERRED_PLACEHOLDER_SPAN);
    return `MODEL_PLACEHOLDER_M${num}`;
}
function toSlug(model) {
    if (model._slug)
        return model._slug;
    return ('custom-' +
        (model.externalModelName || model.name)
            .replace(/^models\//, '')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase());
}
const lastOccupiedPlaceholders = new Set();
const lastAssignedPlaceholderBySlug = new Map();
// Собирает все MODEL_PLACEHOLDER_M*, уже занятые в ответе сервера Google (модели, устаревшие/уровневые ID).
function collectOccupiedPlaceholders(payload) {
    const occupied = new Set();
    if (!payload)
        return occupied;
    const addIfPlaceholder = (val) => {
        if (typeof val !== 'string')
            return;
        const match = /MODEL_PLACEHOLDER_M\d+/.exec(val);
        if (match)
            occupied.add(match[0]);
    };
    addIfPlaceholder(payload.defaultAgentModelId);
    for (const key of ['models', 'availableModels', 'available_models', 'deprecatedModelIds', 'tieredModelIds']) {
        const container = payload[key];
        if (Array.isArray(container)) {
            for (const item of container) {
                if (typeof item === 'string') {
                    addIfPlaceholder(item);
                }
                else if (item && typeof item === 'object') {
                    const obj = item;
                    addIfPlaceholder(obj.model);
                    addIfPlaceholder(obj.name);
                    addIfPlaceholder(obj.modelName);
                    addIfPlaceholder(obj.newModelId);
                }
            }
        }
        else if (container && typeof container === 'object') {
            for (const [k, v] of Object.entries(container)) {
                addIfPlaceholder(k);
                if (typeof v === 'string') {
                    addIfPlaceholder(v);
                }
                else if (v && typeof v === 'object') {
                    const obj = v;
                    addIfPlaceholder(obj.model);
                    addIfPlaceholder(obj.name);
                    addIfPlaceholder(obj.modelName);
                    addIfPlaceholder(obj.newModelId);
                }
            }
        }
    }
    return occupied;
}
function pickFreePlaceholderId(preferredPlaceholderId, usedPlaceholders) {
    if (!usedPlaceholders.has(preferredPlaceholderId)) {
        return preferredPlaceholderId;
    }
    const baseNum = parseInt(preferredPlaceholderId.replace('MODEL_PLACEHOLDER_M', ''), 10);
    const startOffset = !isNaN(baseNum) && baseNum >= PREFERRED_PLACEHOLDER_MIN && baseNum <= VALID_PLACEHOLDER_MAX
        ? baseNum - PREFERRED_PLACEHOLDER_MIN
        : 0;
    // Сначала перебираем свободные слоты в верхнем поддиапазоне [1000..1650].
    for (let step = 1; step < PREFERRED_PLACEHOLDER_SPAN; step++) {
        const candidateNum = PREFERRED_PLACEHOLDER_MIN + ((startOffset + step) % PREFERRED_PLACEHOLDER_SPAN);
        const candidate = `MODEL_PLACEHOLDER_M${candidateNum}`;
        if (!usedPlaceholders.has(candidate)) {
            return candidate;
        }
    }
    // Запасной перебор по остальным валидным слотам [999..0].
    for (let candidateNum = PREFERRED_PLACEHOLDER_MIN - 1; candidateNum >= VALID_PLACEHOLDER_MIN; candidateNum--) {
        const candidate = `MODEL_PLACEHOLDER_M${candidateNum}`;
        if (!usedPlaceholders.has(candidate)) {
            return candidate;
        }
    }
    electron_log_1.default.warn('[Proxy] All valid MODEL_PLACEHOLDER_M0..M1650 slots are occupied; reusing candidate.');
    return preferredPlaceholderId;
}
// Гарантирует уникальные слаги и свободные валидные placeholder ID (без коллизий с Google и между кастомными моделями).
function resolveCustomModelKeys(models, occupiedPlaceholders) {
    const usedSlugs = new Set();
    const usedPlaceholders = new Set(occupiedPlaceholders);
    return models.map((model) => {
        const placeholderId = pickFreePlaceholderId(generateModelPlaceholderId(model), usedPlaceholders);
        usedPlaceholders.add(placeholderId);
        const baseSlug = toSlug(model);
        let slug = baseSlug;
        if (usedSlugs.has(slug)) {
            const prov = (model.provider || 'custom')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'custom';
            slug = `${baseSlug}-${prov}`;
            let suffix = 2;
            while (usedSlugs.has(slug)) {
                slug = `${baseSlug}-${prov}-${suffix++}`;
            }
        }
        usedSlugs.add(slug);
        model._slug = slug;
        return { model, slug, placeholderId };
    });
}
function expandCustomModels(models) {
    const result = [];
    for (const m of models) {
        if (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0) {
            const baseClean = (m.name || '').replace(/^models\//, '');
            const baseDisplay = m.displayName || baseClean;
            for (const effort of m.reasoningEfforts) {
                const effortLabel = effort.charAt(0).toUpperCase() + effort.slice(1);
                const childName = `models/${baseClean}-${effort}`;
                const childSlug = `custom-${(m.externalModelName || baseClean).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}-${effort}`;
                result.push({
                    ...m,
                    name: childName,
                    displayName: `${baseDisplay} ${effortLabel}`,
                    reasoningEffort: effort,
                    _slug: childSlug,
                    reasoningEfforts: undefined,
                });
            }
        }
        else {
            result.push(m);
        }
    }
    return result;
}
// ─── Model Loading ────────────────────────────────────────────────────────
function loadCustomModels() {
    const filePath = getCustomModelsPath();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { validateCustomModel } = require('./schemaValidator');
    if (!fs.existsSync(filePath)) {
        const defaultModels = {
            models: [
                {
                    name: 'models/gpt-4o',
                    displayName: 'GPT-4o (OpenAI via Proxy)',
                    description: 'OpenAI GPT-4o model redirected through proxy',
                    provider: 'openai',
                    apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
                    apiUrl: 'https://api.openai.com/v1/chat/completions',
                    externalModelName: 'gpt-4o',
                },
                {
                    name: 'models/claude-3-5-sonnet',
                    displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
                    description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
                    provider: 'anthropic',
                    apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
                    apiUrl: 'https://api.anthropic.com/v1/messages',
                    externalModelName: 'claude-3-5-sonnet-latest',
                },
                {
                    name: 'models/llama3',
                    displayName: 'Llama 3 (Local Ollama)',
                    description: 'Local Ollama Llama 3 model run on your machine',
                    provider: 'ollama',
                    apiUrl: 'http://localhost:11434/v1/chat/completions',
                    externalModelName: 'llama3',
                },
            ],
        };
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            defaultModels.models.forEach((m) => {
                m.encrypted = false;
            });
            const encrypted = cryptoStore.encryptModels(defaultModels.models);
            fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
        }
        catch (e) {
            electron_log_1.default.error('[Proxy] Failed to write default custom_models.json', e);
        }
        return cryptoStore.decryptModels(defaultModels.models);
    }
    try {
        const models = (0, modelStore_1.readModelConfig)(filePath);
        // Auto-migration check
        const unprotected = (value) => typeof value === 'string' && value && value !== 'none' && !/^(enc:|fallback:|local-gcm:)/.test(value);
        const needsMigration = models.some((m) => (!m.encrypted && unprotected(m.apiKey)) ||
            (!m.encryptedHeaders && Object.values(m.customHeaders || {}).some(unprotected)) ||
            (!m.encryptedGoogleAccounts && (m.googleAccounts || []).some((account) => [account.accessToken, account.refreshToken, account.clientSecret].some(unprotected))));
        if (needsMigration) {
            electron_log_1.default.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
            cryptoStore.backupFile(filePath);
            const encryptedModels = cryptoStore.encryptModels(models);
            for (const model of encryptedModels) {
                if (model.customHeaders && !model.encryptedHeaders) {
                    model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([name, value]) => [name, unprotected(value) ? cryptoStore.encryptString(value) : value]));
                    model.encryptedHeaders = true;
                }
                if (model.googleAccounts && !model.encryptedGoogleAccounts) {
                    model.googleAccounts = model.googleAccounts.map((account) => {
                        const encrypted = { ...account };
                        for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                            if (unprotected(encrypted[field]))
                                encrypted[field] = cryptoStore.encryptString(encrypted[field]);
                        return encrypted;
                    });
                    model.encryptedGoogleAccounts = true;
                }
            }
            try {
                (0, modelStore_1.writeJsonAtomic)(filePath, { models: encryptedModels });
                electron_log_1.default.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');
                // Continue through validation and enabled filtering below.
            }
            catch (err) {
                electron_log_1.default.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
            }
        }
        const decrypted = cryptoStore.decryptModels(models);
        for (const model of decrypted) {
            if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(model.apiKey || '')) {
                model.enabled = false;
                electron_log_1.default.warn('[Proxy] Skipping a model whose API key could not be decrypted');
                continue;
            }
            if (model.googleAccounts) {
                model.googleAccounts = model.googleAccounts.flatMap((account) => {
                    const decryptedAccount = { ...account };
                    for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
                        const value = decryptedAccount[field];
                        if (!value)
                            continue;
                        if (model.encryptedGoogleAccounts)
                            decryptedAccount[field] = cryptoStore.decryptString(value);
                        if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedAccount[field] || '')) {
                            electron_log_1.default.warn('[Proxy] Skipping a Google account whose credentials could not be decrypted');
                            return [];
                        }
                    }
                    return [decryptedAccount];
                });
                model.encryptedGoogleAccounts = false;
            }
            if (model.encryptedHeaders && model.customHeaders) {
                model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([key, value]) => {
                    const decryptedHeader = cryptoStore.decryptString(value);
                    if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedHeader || '')) {
                        model.enabled = false;
                        electron_log_1.default.warn('[Proxy] Skipping a model whose custom header could not be decrypted');
                    }
                    return [key, decryptedHeader];
                }));
                model.encryptedHeaders = false;
            }
        }
        // Validate all models
        const validModels = [];
        for (let i = 0; i < decrypted.length; i++) {
            const validation = validateCustomModel(decrypted[i]);
            if (validation.valid) {
                if (decrypted[i].enabled !== false)
                    validModels.push(decrypted[i]);
            }
            else {
                electron_log_1.default.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
            }
        }
        if (validModels.length < decrypted.length) {
            electron_log_1.default.info(`[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`);
        }
        return expandCustomModels(validModels);
    }
    catch (e) {
        electron_log_1.default.error('[Proxy] Failed to parse custom_models.json', e);
        return [];
    }
}
// ─── Google Proxy ─────────────────────────────────────────────────────────
function proxyToGoogle(req, res, reqBody) {
    const isAiStudio = req.url.includes('generativelanguage.googleapis.com') ||
        (typeof req.headers.host === 'string' && req.headers.host.includes('generativelanguage'));
    const isCloudCodeUrl = !isAiStudio;
    const targetHost = isAiStudio ? 'generativelanguage.googleapis.com' : 'daily-cloudcode-pa.googleapis.com';
    const targetUrl = `https://${targetHost}`;
    const parsedUrl = new URL(req.url, targetUrl);
    const headers = {
        ...req.headers,
    };
    headers['host'] = targetHost;
    delete headers['connection'];
    delete headers['keep-alive'];
    const isGeneration = req.url.includes('generateContent') || req.url.includes('streamGenerateContent');
    const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;
    if (shouldBufferAndModify) {
        delete headers['accept-encoding'];
    }
    const options = {
        method: req.method,
        headers: headers,
    };
    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
        // For generation requests (streaming & thinking models), allow up to 15 minutes
        // and refresh timeout on every data chunk. For metadata requests, use 60s.
        const timeoutMs = isGeneration ? 900000 : 60000;
        proxyReq.setTimeout(timeoutMs, () => {
            electron_log_1.default.error(`[Proxy] Google proxy ${isGeneration ? 'generation' : 'metadata'} request timed out after ${timeoutMs / 1000}s`);
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
            }
        });
        if (shouldBufferAndModify) {
            const responseChunks = [];
            proxyRes.on('data', (chunk) => {
                proxyReq.setTimeout(timeoutMs);
                responseChunks.push(chunk);
            });
            proxyRes.on('end', () => {
                const fullResBody = Buffer.concat(responseChunks);
                let text;
                const encoding = proxyRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try {
                        const zlib = require('zlib');
                        text = zlib.gunzipSync(fullResBody).toString('utf-8');
                    }
                    catch (e) {
                        electron_log_1.default.error('[Proxy] gunzipSync failed:', e);
                        text = fullResBody.toString('utf-8');
                    }
                }
                else {
                    text = fullResBody.toString('utf-8');
                }
                electron_log_1.default.info(`[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`);
                // P0-3: Response body content is NOT logged to disk. Only metadata.
                const proxyHost = req.headers.host || 'localhost';
                text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
                text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);
                // Disable failing V2 WebChannel remote control which triggers aborted connections in language_server
                if (req.url && req.url.includes('listExperiments')) {
                    text = text.replace(/"RemoteControlEnabled":\s*true/g, '"RemoteControlEnabled":false');
                    text = text.replace(/"remote_control_enabled":\s*true/g, '"remote_control_enabled":false');
                }
                const modifiedHeaders = { ...proxyRes.headers };
                delete modifiedHeaders['content-encoding'];
                const modifiedBuffer = Buffer.from(text, 'utf-8');
                modifiedHeaders['content-length'] = String(modifiedBuffer.length);
                if (!res.headersSent) {
                    res.writeHead(proxyRes.statusCode || 200, modifiedHeaders);
                    res.end(modifiedBuffer);
                }
                else {
                    res.end();
                }
            });
        }
        else {
            if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            }
            proxyRes.on('data', () => {
                proxyReq.setTimeout(timeoutMs);
            });
            proxyRes.pipe(res);
        }
    });
    proxyReq.on('error', (err) => {
        electron_log_1.default.error('[Proxy] Google Forwarding Error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
        }
        else {
            res.end();
        }
    });
    if (reqBody) {
        proxyReq.write(reqBody);
    }
    proxyReq.end();
}
// ─── File Data Resolver ────────────────────────────────────────────────────
async function resolveFileData(body, reqHeaders) {
    const contents = body.contents;
    if (!contents)
        return;
    const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '');
    for (const item of contents) {
        if (!item.parts)
            continue;
        for (let i = 0; i < item.parts.length; i++) {
            const p = item.parts[i];
            const fd = p.fileData;
            if (!fd?.fileUri)
                continue;
            try {
                const uri = fd.fileUri;
                let fileContent = '';
                if (uri.startsWith('file://')) {
                    const fp = uri.replace('file://', '').replace(/\//g, path.sep);
                    if (fs.existsSync(fp))
                        fileContent = fs.readFileSync(fp, 'utf-8');
                }
                else if (authHeader && uri.startsWith('https://')) {
                    fileContent = await downloadFileContent(uri, authHeader);
                }
                if (fileContent) {
                    item.parts[i] = { text: '[File content]:\n\n' + fileContent };
                }
            }
            catch (e) {
                electron_log_1.default.warn('[Proxy] File resolve failed:', e.message);
            }
        }
    }
}
function downloadFileContent(url, authHeader) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        (u.protocol === 'https:' ? https : http).request({
            hostname: u.hostname, path: u.pathname + u.search,
            method: 'GET', headers: { 'Authorization': authHeader }, timeout: 30000,
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            let d = '';
            res.on('data', (c) => d += c.toString());
            res.on('end', () => resolve(d));
        }).on('error', reject).end();
    });
}
// ─── Custom Model Request Handler ─────────────────────────────────────────
function handleCustomModelRequest(res, model, body, isStream, cloudEnvelope = true) {
    void (0, customRequest_1.runCustomModelRequest)(res, model, body, isStream, loadCustomModels(), cloudEnvelope);
}
function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let bytes = 0;
    while (offset + bytes < buf.length) {
        const byte = buf[offset + bytes];
        result |= (byte & 0x7f) << shift;
        bytes++;
        if (!(byte & 0x80))
            break;
        shift += 7;
    }
    return { value: result >>> 0, bytes };
}
function encodeVarint(value) {
    const parts = [];
    let v = value >>> 0;
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0)
            b |= 0x80;
        parts.push(b);
    } while (v !== 0);
    return Buffer.from(parts);
}
function parseProto(buf, offset, end) {
    const fields = [];
    let pos = offset;
    while (pos < end) {
        const start = pos;
        const tagVarint = readVarint(buf, pos);
        const tag = tagVarint.value;
        const wireType = tag & 0x07;
        const fieldNum = tag >>> 3;
        pos += tagVarint.bytes;
        if (wireType === 0) {
            const v = readVarint(buf, pos);
            fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
            pos += v.bytes;
        }
        else if (wireType === 2) {
            const lenVarint = readVarint(buf, pos);
            pos += lenVarint.bytes;
            const len = lenVarint.value;
            const children = parseProto(buf, pos, pos + len);
            const hasChildren = children.length > 0;
            fields.push({ tag, wireType, fieldNum, value: hasChildren ? children : buf.subarray(pos, pos + len), start, end: pos + len });
            pos += len;
        }
        else if (wireType === 1) {
            fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
            pos += 8;
        }
        else if (wireType === 5) {
            fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
            pos += 4;
        }
        else {
            break;
        }
    }
    return fields;
}
function encodeProtoBuf(fields) {
    const parts = [];
    for (const field of fields) {
        const tagBuf = encodeVarint(field.tag);
        const data = field.value;
        const lenBuf = encodeVarint(data.length);
        parts.push(tagBuf, lenBuf, data);
    }
    return Buffer.concat(parts);
}
function findModelEntryFieldTag(fields) {
    const tagCounts = new Map();
    for (const f of fields) {
        if (f.wireType === 2) {
            tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
        }
    }
    let bestTag = null;
    let bestCount = 0;
    for (const [tag, count] of tagCounts) {
        if (count > bestCount) {
            bestCount = count;
            bestTag = tag;
        }
    }
    if (bestTag !== null && bestCount >= 2) {
        // Verify it has nested messages
        const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
        if (sample)
            return bestTag;
    }
    return bestTag;
}
function extractFieldMapping(entry) {
    const mapping = new Map();
    for (const f of entry) {
        if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
            mapping.set(f.fieldNum, 'string');
        }
        else if (f.wireType === 0) {
            mapping.set(f.fieldNum, 'varint');
        }
        else if (f.wireType === 2 && Array.isArray(f.value)) {
            mapping.set(f.fieldNum, 'bytes');
        }
    }
    return mapping;
}
function encodeModelEntryForGetModels(name, displayName, mapping) {
    const fields = [];
    for (const [fieldNum, protoType] of mapping) {
        if (protoType === 'string') {
            const tag = (fieldNum << 3) | 2;
            if (fieldNum === 1) {
                fields.push({ tag, value: Buffer.from(name, 'utf-8') });
            }
            else if (fieldNum === 2) {
                fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
            }
            else {
                fields.push({ tag, value: Buffer.alloc(0) });
            }
        }
        else if (protoType === 'varint') {
            const tag = (fieldNum << 3) | 0;
            fields.push({ tag, value: encodeVarint(0) });
        }
        else {
            const tag = (fieldNum << 3) | 2;
            fields.push({ tag, value: Buffer.alloc(0) });
        }
    }
    return encodeProtoBuf(fields);
}
let lastKnownGetModelsRawBuf = null;
let lastKnownFetchAvailableModelsJson = null;
let lastKnownListModelsJson = null;
function buildSyntheticGetModelsResponse(customModels) {
    const fieldMapping = new Map([
        [1, 'string'],
        [2, 'string'],
    ]);
    const parts = [];
    const modelTag = (1 << 3) | 2; // Tag 1, length-delimited (wireType 2)
    // Без фейковых нативных моделей: если кэша от LS/Google нет, рисуем только активные кастомные модели.
    for (const { model: m, placeholderId } of resolveCustomModelKeys(customModels, lastOccupiedPlaceholders)) {
        const entry = encodeModelEntryForGetModels('models/' + placeholderId, m.displayName, fieldMapping);
        parts.push(encodeVarint(modelTag), encodeVarint(entry.length), entry);
    }
    const msgBody = Buffer.concat(parts);
    const header = Buffer.alloc(5);
    header[0] = 0;
    header.writeUInt32BE(msgBody.length, 1);
    return Buffer.concat([header, msgBody]);
}
function injectCustomModelsIntoProto(responseBuf, customModels) {
    if (customModels.length === 0 || responseBuf.length <= 5) {
        return responseBuf;
    }
    try {
        const flags = responseBuf[0];
        const msgLen = responseBuf.readUInt32BE(1);
        if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed) ?? ((1 << 3) | 2);
            const sampleEntry = parsed.find((f) => f.tag === modelTag && Array.isArray(f.value));
            const fieldMapping = sampleEntry && Array.isArray(sampleEntry.value)
                ? extractFieldMapping(sampleEntry.value)
                : new Map([
                    [1, 'string'],
                    [2, 'string'],
                ]);
            const newParts = [msgBody];
            for (const { model: m, placeholderId } of resolveCustomModelKeys(customModels, lastOccupiedPlaceholders)) {
                const entry = encodeModelEntryForGetModels('models/' + placeholderId, m.displayName, fieldMapping);
                const tagBuf = encodeVarint(modelTag);
                const lenBuf = encodeVarint(entry.length);
                newParts.push(tagBuf, lenBuf, entry);
                electron_log_1.default.info(`[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`);
            }
            const newMsgBody = Buffer.concat(newParts);
            const newHeader = Buffer.alloc(5);
            newHeader[0] = flags;
            newHeader.writeUInt32BE(newMsgBody.length, 1);
            return Buffer.concat([newHeader, newMsgBody]);
        }
    }
    catch (err) {
        electron_log_1.default.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
    }
    return responseBuf;
}
// ─── GetAvailableModels Proxy Handler ───────────────────────────────────────
function handleGetAvailableModelsProxy(res, reqBody, lsUrl) {
    let lsParsed;
    try {
        lsParsed = new URL(lsUrl);
        if (!['http:', 'https:'].includes(lsParsed.protocol))
            throw new Error('Invalid protocol');
    }
    catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid language server URL' } }));
        return;
    }
    const client = lsParsed.protocol === 'https:' ? https : http;
    const options = {
        method: 'POST',
        hostname: lsParsed.hostname,
        port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
        path: lsParsed.pathname + lsParsed.search,
        headers: {
            'Content-Type': 'application/grpc-web+proto',
            'Accept': 'application/grpc-web+proto',
            'Content-Length': String(reqBody.length),
        },
        rejectUnauthorized: false,
    };
    const sendFallbackModels = (reason) => {
        if (res.headersSent)
            return;
        electron_log_1.default.warn(`[Proxy] GetAvailableModels ${reason}, serving offline fallback with custom models`);
        const customModels = loadCustomModels();
        let fallbackBuf;
        if (lastKnownGetModelsRawBuf && lastKnownGetModelsRawBuf.length > 5) {
            fallbackBuf = injectCustomModelsIntoProto(lastKnownGetModelsRawBuf, customModels);
        }
        else {
            fallbackBuf = buildSyntheticGetModelsResponse(customModels);
        }
        res.writeHead(200, {
            'Content-Type': 'application/grpc-web+proto',
            'Content-Length': String(fallbackBuf.length),
        });
        res.end(fallbackBuf);
    };
    const lsReq = client.request(options, (lsRes) => {
        const chunks = [];
        lsRes.on('data', (chunk) => chunks.push(chunk));
        lsRes.on('end', () => {
            const responseBuf = Buffer.concat(chunks);
            if (lsRes.statusCode !== 200 || responseBuf.length <= 5) {
                electron_log_1.default.warn(`[Proxy] LS returned status ${lsRes.statusCode}, body length ${responseBuf.length}; serving fallback models`);
                sendFallbackModels(`status ${lsRes.statusCode}`);
                return;
            }
            lastKnownGetModelsRawBuf = responseBuf;
            const customModels = loadCustomModels();
            const modifiedBuf = injectCustomModelsIntoProto(responseBuf, customModels);
            if (!res.headersSent) {
                res.writeHead(200, {
                    'Content-Type': 'application/grpc-web+proto',
                    'Content-Length': String(modifiedBuf.length),
                });
                res.end(modifiedBuf);
            }
        });
        lsRes.on('error', (err) => {
            electron_log_1.default.error('[Proxy] LS error for GetAvailableModels:', err.message);
            sendFallbackModels('LS response error');
        });
    });
    lsReq.setTimeout(10000, () => {
        electron_log_1.default.warn('[Proxy] GetAvailableModels forward timed out (10s)');
        lsReq.destroy();
        sendFallbackModels('forward timeout');
    });
    lsReq.on('error', (err) => {
        electron_log_1.default.error('[Proxy] GetAvailableModels forward error:', err.message);
        sendFallbackModels('forward error');
    });
    lsReq.write(reqBody);
    lsReq.end();
}
const BASE_MIME_TYPES = {
    'text/plain': true,
    'text/markdown': true,
    'text/html': true,
    'text/css': true,
    'text/xml': true,
    'text/csv': true,
    'application/json': true,
    'application/pdf': true,
    'application/x-javascript': true,
    'application/x-typescript': true,
    'application/x-python-code': true,
    'application/x-ipynb+json': true,
};
const IMAGE_MIME_TYPES = {
    'image/png': true,
    'image/jpeg': true,
    'image/webp': true,
    'image/gif': true,
    'image/heic': true,
    'image/heif': true,
    ...BASE_MIME_TYPES,
};
function buildCustomCloudCodeEntry(m, placeholderId) {
    const cap = (0, modelUtils_1.detectModelCapabilities)(m, true);
    return {
        displayName: m.displayName,
        supportsImages: cap.supportsImages,
        supportsThinking: cap.isThinking,
        recommended: true,
        maxTokens: cap.maxTokens,
        maxOutputTokens: cap.maxOutputTokens,
        tokenizerType: 'LLAMA_WITH_SPECIAL',
        model: placeholderId,
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        supportsVideo: false,
        supportedMimeTypes: cap.supportsImages ? IMAGE_MIME_TYPES : BASE_MIME_TYPES,
    };
}
function buildCustomV1BetaEntry(m, placeholderId) {
    const cap = (0, modelUtils_1.detectModelCapabilities)(m, true);
    return {
        name: `models/${placeholderId}`,
        version: '1.0',
        displayName: m.displayName,
        description: m.description,
        inputTokenLimit: cap.maxTokens,
        outputTokenLimit: cap.maxOutputTokens,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        ...(cap.isThinking ? {} : { temperature: 0.7, topP: 0.9, topK: 40 }),
    };
}
function appendCustomEntriesToMap(targetMap, resolved) {
    const hasOwnKey = (key) => Object.prototype.hasOwnProperty.call(targetMap, key);
    for (const { model, slug, placeholderId } of resolved) {
        const entry = buildCustomCloudCodeEntry(model, placeholderId);
        for (const key of [slug, `models/${slug}`, placeholderId, `models/${placeholderId}`]) {
            // Никогда не перезаписываем существующие оригинальные модели Google.
            if (!hasOwnKey(key))
                targetMap[key] = entry;
        }
    }
}
function injectSlugsIntoAgentModelSorts(result, customSlugs) {
    if (customSlugs.length === 0)
        return;
    if (Array.isArray(result.agentModelSorts) && result.agentModelSorts.length > 0) {
        let added = false;
        for (const sort of result.agentModelSorts) {
            if (!sort || !Array.isArray(sort.groups))
                continue;
            for (const group of sort.groups) {
                if (group && Array.isArray(group.modelIds)) {
                    for (const slug of customSlugs) {
                        if (!group.modelIds.includes(slug))
                            group.modelIds.push(slug);
                    }
                    added = true;
                }
            }
        }
        if (added)
            return;
    }
    const existing = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
    result.agentModelSorts = [...existing, { displayName: 'Custom Models', groups: [{ modelIds: customSlugs }] }];
}
function mergeFetchAvailableModelsResponse(googleJson, customModels) {
    const occupied = collectOccupiedPlaceholders(googleJson);
    if (occupied.size > 0) {
        lastOccupiedPlaceholders.clear();
        for (const id of occupied)
            lastOccupiedPlaceholders.add(id);
    }
    const resolved = resolveCustomModelKeys(customModels, occupied);
    lastAssignedPlaceholderBySlug.clear();
    for (const { slug, placeholderId } of resolved) {
        lastAssignedPlaceholderBySlug.set(slug, placeholderId);
    }
    const customSlugs = resolved.map((r) => r.slug);
    const result = googleJson
        ? JSON.parse(JSON.stringify(googleJson))
        : {};
    const serverKey = result.models
        ? 'models'
        : result.availableModels
            ? 'availableModels'
            : result.available_models
                ? 'available_models'
                : null;
    if (serverKey) {
        const serverValue = result[serverKey];
        if (Array.isArray(serverValue)) {
            const existingNames = new Set(serverValue
                .filter((item) => Boolean(item && typeof item === 'object'))
                .map((item) => String(item.name ?? item.model ?? '')));
            const additions = resolved
                .filter(({ placeholderId }) => !existingNames.has(`models/${placeholderId}`) && !existingNames.has(placeholderId))
                .map(({ model, placeholderId }) => buildCustomV1BetaEntry(model, placeholderId));
            result[serverKey] = [...serverValue, ...additions];
        }
        else if (serverValue && typeof serverValue === 'object') {
            const mergedMap = { ...serverValue };
            appendCustomEntriesToMap(mergedMap, resolved);
            result[serverKey] = mergedMap;
        }
    }
    else {
        const customMap = {};
        appendCustomEntriesToMap(customMap, resolved);
        result.models = customMap;
    }
    injectSlugsIntoAgentModelSorts(result, customSlugs);
    return result;
}
function mergeListModelsResponse(googleJson, customModels) {
    const occupied = new Set(lastOccupiedPlaceholders);
    for (const id of collectOccupiedPlaceholders(googleJson)) {
        occupied.add(id);
    }
    const resolved = resolveCustomModelKeys(customModels, occupied);
    const result = googleJson
        ? JSON.parse(JSON.stringify(googleJson))
        : {};
    if (Array.isArray(result.models)) {
        const existingNames = new Set(result.models
            .filter((item) => Boolean(item && typeof item === 'object'))
            .map((item) => String(item.name ?? item.model ?? '')));
        const additions = resolved
            .filter(({ placeholderId }) => !existingNames.has(`models/${placeholderId}`) && !existingNames.has(placeholderId))
            .map(({ model, placeholderId }) => buildCustomV1BetaEntry(model, placeholderId));
        result.models = [...result.models, ...additions];
    }
    else if (result.models && typeof result.models === 'object') {
        const mergedMap = { ...result.models };
        appendCustomEntriesToMap(mergedMap, resolved);
        result.models = mergedMap;
    }
    else {
        result.models = resolved.map(({ model, placeholderId }) => buildCustomV1BetaEntry(model, placeholderId));
    }
    return result;
}
function sendMergedJsonResponse(res, payload) {
    if (res.headersSent)
        return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}
function findMatchedCustomModel(customModels, modelName, modelId) {
    const resolved = resolveCustomModelKeys(customModels);
    const cleanModelName = (modelName || '').replace(/^models\//, '');
    const isNativeRequest = Boolean((cleanModelName && (0, modelUtils_1.isNativeGoogleModelName)(cleanModelName)) ||
        (modelName && (0, modelUtils_1.isNativeGoogleModelName)(modelName)));
    // Сначала ищем по уникальным кастомным идентификаторам (slug и выданному placeholderId).
    const byCustomId = resolved.find(({ slug, placeholderId }) => {
        const assignedPlaceholder = lastAssignedPlaceholderBySlug.get(slug);
        return (slug === modelName ||
            slug === cleanModelName ||
            `models/${slug}` === modelName ||
            placeholderId === modelName ||
            placeholderId === cleanModelName ||
            `models/${placeholderId}` === modelName ||
            (assignedPlaceholder
                ? assignedPlaceholder === modelName ||
                    assignedPlaceholder === cleanModelName ||
                    `models/${assignedPlaceholder}` === modelName
                : false) ||
            (modelId
                ? placeholderId === modelId || slug === modelId || assignedPlaceholder === modelId
                : false));
    });
    if (byCustomId)
        return byCustomId.model;
    // Защита оригинальных моделей Google: запрос по нативному имени никогда не перехватывается кастомным именем.
    if (isNativeRequest)
        return undefined;
    return resolved.find(({ model }) => {
        const cleanMName = (model.name || '').replace(/^models\//, '');
        return Boolean((modelName && model.name === modelName) || (cleanModelName && cleanMName === cleanModelName));
    })?.model;
}
// ─── Main Request Handler ─────────────────────────────────────────────────
function handleRequest(req, res) {
    let requestUrl;
    try {
        req.url = (req.url || '/').replace(/^.*\/dummy_path_padding/, '');
        // Strip binary patch padding (from LS hostname replacement)
        req.url = req.url.replace(/\/v1internal\/x{7}/, '');
        // This listener routes fixed upstreams; authority-form targets must never replace them.
        if (!req.url.startsWith('/') || /^[\\/]{2}/.test(req.url))
            throw new Error('Invalid target');
        requestUrl = new URL(req.url, 'http://localhost');
    }
    catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid request target' } }));
        return;
    }
    // Health check
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        const memUsage = process.memoryUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            port: proxyPort,
            memory: {
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            },
            state: {
                activeStreamContexts: shared_1.activeStreamContexts.size,
                modelToolCallIds: shared_1.modelToolCallIds.size,
                translatedToolCalls: shared_1.translatedToolCalls.size,
                modelReasoningContent: shared_1.modelReasoningContent.size,
            },
            timestamp: new Date().toISOString(),
        }));
        return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify((0, customRequest_1.getProxyMetrics)()));
        return;
    }
    // P0-4: Enforce maximum request body size to prevent memory exhaustion DoS
    const MAX_BODY_SIZE = 150 * 1024 * 1024; // 150 MB (Support large Agentic workspaces/indices)
    let bodyLength = 0;
    let bodyRejected = false;
    const bodyChunks = [];
    req.on('data', (chunk) => {
        bodyLength += chunk.length;
        if (bodyLength > MAX_BODY_SIZE) {
            if (!bodyRejected) {
                bodyRejected = true;
                electron_log_1.default.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
                req.destroy();
                if (!res.headersSent) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }));
                }
            }
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', () => {
        if (bodyRejected)
            return;
        const fullBody = Buffer.concat(bodyChunks);
        const bodyStr = fullBody.toString('utf-8');
        electron_log_1.default.info(`[Proxy] Request: ${req.method} ${req.url}`);
        // 0. Intercept GetAvailableModels (redirected from Electron webRequest)
        if (req.url.startsWith('/GetAvailableModels')) {
            const gavParsed = new URL(req.url, 'http://127.0.0.1');
            const lsUrl = gavParsed.searchParams.get('ls');
            if (lsUrl) {
                handleGetAvailableModelsProxy(res, fullBody, lsUrl);
                return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing ls parameter' }));
            return;
        }
        // 1. Intercept /v1internal:fetchAvailableModels
        if (req.url.includes('/v1internal:fetchAvailableModels')) {
            electron_log_1.default.info('[Proxy] Intercepting fetchAvailableModels request');
            const sendFetchFallback = (reason) => {
                if (res.headersSent)
                    return;
                const customModels = loadCustomModels();
                electron_log_1.default.warn(`[Proxy] fetchAvailableModels fallback (${reason}): cached=${Boolean(lastKnownFetchAvailableModelsJson)}, custom=${customModels.length}`);
                sendMergedJsonResponse(res, mergeFetchAvailableModelsResponse(lastKnownFetchAvailableModelsJson, customModels));
            };
            const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const fwdHeaders = {
                ...req.headers,
            };
            fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
            delete fwdHeaders['connection'];
            delete fwdHeaders['keep-alive'];
            delete fwdHeaders['accept-encoding'];
            const fwdOptions = {
                method: req.method,
                headers: fwdHeaders,
            };
            const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {
                // Если Google не ответил за 5с — отдаём последний кэш + наши кастомные модели.
                googleReq.setTimeout(5000, () => {
                    googleReq.destroy();
                    sendFetchFallback('timeout');
                });
                let googleBody = '';
                googleRes.on('data', (chunk) => (googleBody += chunk));
                googleRes.on('end', () => {
                    try {
                        electron_log_1.default.info(`[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`);
                        if (googleRes.statusCode !== 200 || googleBody.length < 5) {
                            throw new Error(`Google PA returned status ${googleRes.statusCode}`);
                        }
                        const googleJson = JSON.parse(googleBody);
                        // Сохраняем чистый ответ Google в кэш до подмешивания кастомных моделей.
                        lastKnownFetchAvailableModelsJson = JSON.parse(JSON.stringify(googleJson));
                        const customModels = loadCustomModels();
                        const result = mergeFetchAvailableModelsResponse(googleJson, customModels);
                        electron_log_1.default.info(`[Proxy] fetchAvailableModels merged cleanly: custom=${customModels.length}`);
                        sendMergedJsonResponse(res, result);
                    }
                    catch (err) {
                        electron_log_1.default.error('[Proxy] Parsing fetchAvailableModels failed:', err);
                        sendFetchFallback('invalid response');
                    }
                });
            });
            googleReq.on('error', (err) => {
                electron_log_1.default.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
                sendFetchFallback('network error');
            });
            if (fullBody && fullBody.length > 0) {
                googleReq.write(fullBody);
            }
            googleReq.end();
            return;
        }
        // 2. Intercept /v1beta/models or /v1/models list request
        if (req.method === 'GET' && (req.url.endsWith('/models') || req.url.includes('/models?'))) {
            electron_log_1.default.info('[Proxy] Intercepting models list request');
            const sendListFallback = (reason) => {
                if (res.headersSent)
                    return;
                const customModels = loadCustomModels();
                electron_log_1.default.warn(`[Proxy] models list fallback (${reason}): cached=${Boolean(lastKnownListModelsJson)}, custom=${customModels.length}`);
                sendMergedJsonResponse(res, mergeListModelsResponse(lastKnownListModelsJson, customModels));
            };
            const targetUrl = 'https://generativelanguage.googleapis.com';
            const parsedUrl = new URL(req.url, targetUrl);
            const mdlHeaders = {
                ...req.headers,
            };
            mdlHeaders['host'] = 'generativelanguage.googleapis.com';
            delete mdlHeaders['connection'];
            delete mdlHeaders['accept-encoding'];
            const mdlOptions = { method: 'GET', headers: mdlHeaders };
            const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {
                googleReq.setTimeout(5000, () => {
                    googleReq.destroy();
                    sendListFallback('timeout');
                });
                let googleBody = '';
                googleRes.on('data', (chunk) => (googleBody += chunk));
                googleRes.on('end', () => {
                    try {
                        if (googleRes.statusCode !== 200 || googleBody.length < 2) {
                            throw new Error(`Google AI Studio returned status ${googleRes.statusCode}`);
                        }
                        const googleJson = JSON.parse(googleBody);
                        lastKnownListModelsJson = JSON.parse(JSON.stringify(googleJson));
                        const customModels = loadCustomModels();
                        const result = mergeListModelsResponse(googleJson, customModels);
                        electron_log_1.default.info(`[Proxy] models list merged cleanly: custom=${customModels.length}`);
                        sendMergedJsonResponse(res, result);
                    }
                    catch (err) {
                        electron_log_1.default.error('[Proxy] Google list models failed:', err);
                        sendListFallback('invalid response');
                    }
                });
            });
            googleReq.on('error', (err) => {
                electron_log_1.default.error('[Proxy] Google models list request error:', err);
                sendListFallback('network error');
            });
            googleReq.end();
            return;
        }
        // 3. Intercept Cloud Code generation stream or non-stream requests
        const isCloudCodeStream = req.url.includes('/v1internal:streamGenerateContent') || req.url.includes('/v1internal:generateContent');
        if (req.method === 'POST' && isCloudCodeStream) {
            try {
                const reqJson = JSON.parse(bodyStr);
                const modelName = reqJson.model;
                const modelId = (reqJson.modelId || reqJson.model_id);
                electron_log_1.default.info(`[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`);
                if (modelName || modelId) {
                    const customModels = loadCustomModels();
                    const matchedCustomModel = findMatchedCustomModel(customModels, modelName, modelId);
                    if (matchedCustomModel) {
                        electron_log_1.default.info(`[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`);
                        const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
                        const actualGeminiBody = { ...(reqJson.request || reqJson) };
                        if (typeof reqJson.sessionId === 'string')
                            actualGeminiBody.sessionId = reqJson.sessionId;
                        if (typeof reqJson.conversationId === 'string')
                            actualGeminiBody.conversationId = reqJson.conversationId;
                        // No provider fallback: the request is served by the selected model only.
                        // Resolve fileData URIs then route to translator
                        resolveFileData(actualGeminiBody, req.headers).then(() => {
                            handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream, true);
                        });
                        return;
                    }
                }
            }
            catch (err) {
                electron_log_1.default.error('[Proxy] Failed to parse Cloud Code stream body:', err);
            }
        }
        // 4. Intercept standard generateContent / streamGenerateContent request
        const generateMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
        const streamMatch = req.url.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);
        const isGenerate = !!generateMatch;
        const isStandardStream = !!streamMatch;
        if (req.method === 'POST' && (isGenerate || isStandardStream)) {
            let matchedModelName;
            try {
                matchedModelName = decodeURIComponent(isGenerate ? generateMatch[1] : streamMatch[1]);
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Invalid model URL encoding' } }));
                return;
            }
            const customModels = loadCustomModels();
            const matchedCustomModel = findMatchedCustomModel(customModels, matchedModelName);
            if (matchedCustomModel) {
                try {
                    const geminiBody = JSON.parse(bodyStr);
                    resolveFileData(geminiBody, req.headers).then(() => {
                        handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream, false);
                    });
                    return;
                }
                catch (e) {
                    electron_log_1.default.error('[Proxy] JSON parse error in request body:', e);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
                    return;
                }
            }
        }
        // 5. Fallback: transparent proxy to Google
        proxyToGoogle(req, res, fullBody);
    });
}
// ─── Server Start/Stop ────────────────────────────────────────────────────
async function startProxy() {
    if (stoppingProxy)
        await stoppingProxy;
    if (server?.listening && proxyPort)
        return proxyPort;
    if (startingProxy)
        return startingProxy;
    const requiredPort = (0, listen_1.getRequiredProxyPort)(electron_1.app.getAppPath());
    const newServer = http.createServer(handleRequest);
    server = newServer;
    (0, shared_1.startCleanupInterval)();
    startingProxy = (0, listen_1.listenProxy)(newServer, requiredPort ?? 50999, requiredPort === undefined)
        .then((port) => {
        proxyPort = port;
        electron_log_1.default.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
        return proxyPort;
    })
        .catch((error) => {
        (0, shared_1.stopCleanupInterval)();
        server = null;
        proxyPort = 0;
        electron_log_1.default.error('[Proxy] Startup failed:', error);
        throw error;
    })
        .finally(() => {
        startingProxy = null;
    });
    return startingProxy;
}
function stopProxy() {
    if (stoppingProxy)
        return stoppingProxy;
    stoppingProxy = (async () => {
        // A shutdown requested during startup must also close the listener once ready.
        if (startingProxy) {
            try {
                await startingProxy;
            }
            catch {
                // A failed start already cleared its server and cleanup interval.
            }
        }
        (0, shared_1.stopCleanupInterval)();
        (0, customRequest_1.stopCustomRequests)();
        if (server) {
            const closingServer = server;
            await new Promise((resolve) => closingServer.close(() => resolve()));
            electron_log_1.default.info('[Proxy] Server stopped');
        }
        server = null;
        proxyPort = 0;
    })().finally(() => {
        stoppingProxy = null;
    });
    return stoppingProxy;
}
function getProxyPort() {
    return proxyPort;
}
//# sourceMappingURL=proxy.js.map