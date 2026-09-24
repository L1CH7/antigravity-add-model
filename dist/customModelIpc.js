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
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupCustomModelIpc = setupCustomModelIpc;
const electron_1 = require("electron");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const cryptoStore_1 = require("./cryptoStore");
function getCustomModelsPath() {
    const homeDir = electron_1.app ? electron_1.app.getPath('home') : process.env.HOME || process.env.USERPROFILE || '';
    return path.join(homeDir, '.gemini', 'antigravity', 'custom_models.json');
}
/**
 * Registers custom model storage and connectivity IPC handlers.
 * Safe to call in any Electron main process environment without overwriting native handlers.
 */
function setupCustomModelIpc(ipc = electron_1.ipcMain) {
    // Read custom models with masked API keys
    ipc.handle('storage:get-custom-models', async () => {
        const filePath = getCustomModelsPath();
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            const models = parsed.models || [];
            return models.map((m) => {
                let maskedKey = m.apiKey;
                if (m.apiKey && m.apiKey !== 'none') {
                    const decrypted = (0, cryptoStore_1.decryptString)(m.apiKey);
                    if (decrypted.length <= 8) {
                        maskedKey = '********';
                    }
                    else {
                        maskedKey = decrypted.substring(0, 4) + '...' + decrypted.substring(decrypted.length - 4);
                    }
                }
                return {
                    ...m,
                    apiKey: maskedKey,
                };
            });
        }
        catch {
            return [];
        }
    });
    // Save or update a custom model with encrypted API key
    ipc.handle('storage:save-custom-model', async (_event, newModel) => {
        const filePath = getCustomModelsPath();
        try {
            let models = [];
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const parsed = JSON.parse(content);
                models = parsed.models || [];
            }
            catch {
                // File does not exist yet
            }
            const existingIdx = models.findIndex((m) => m.name === newModel.name);
            // Preserve existing encrypted key if user didn't modify masked value
            const isMasked = newModel.apiKey &&
                (newModel.apiKey.includes('...') || newModel.apiKey.startsWith('***') || newModel.apiKey === '********');
            if (isMasked && existingIdx !== -1) {
                newModel.apiKey = models[existingIdx].apiKey;
                newModel.encrypted = models[existingIdx].encrypted;
            }
            else {
                if (newModel.apiKey && newModel.apiKey !== 'none') {
                    newModel.apiKey = (0, cryptoStore_1.encryptString)(newModel.apiKey);
                    newModel.encrypted = true;
                }
            }
            if (existingIdx !== -1) {
                models[existingIdx] = newModel;
            }
            else {
                models.push(newModel);
            }
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify({ models }, null, 2), 'utf-8');
            return { success: true };
        }
        catch (err) {
            console.error('[IPC] Failed to save custom model:', err);
            return { success: false, error: err.message };
        }
    });
    // Delete a custom model
    ipc.handle('storage:delete-custom-model', async (_event, modelName) => {
        const filePath = getCustomModelsPath();
        try {
            let models = [];
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const parsed = JSON.parse(content);
                models = parsed.models || [];
            }
            catch {
                // File does not exist
            }
            models = models.filter((m) => m.name !== modelName);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify({ models }, null, 2), 'utf-8');
            return { success: true };
        }
        catch (err) {
            console.error('[IPC] Failed to delete custom model:', err);
            return { success: false, error: err.message };
        }
    });
    // Test model endpoint reachability
    ipc.handle('storage:test-model-connection', async (_event, model) => {
        return new Promise((resolve) => {
            try {
                let urlStr = model.apiUrl;
                if (model.provider === 'openai' || model.provider === 'custom' || model.provider === 'ollama') {
                    if (!urlStr.toLowerCase().includes('/chat/completions') && !urlStr.toLowerCase().includes('/completions')) {
                        if (urlStr.endsWith('/v1')) {
                            urlStr += '/chat/completions';
                        }
                        else if (!urlStr.endsWith('/')) {
                            urlStr += '/v1/chat/completions';
                        }
                        else {
                            urlStr += 'v1/chat/completions';
                        }
                    }
                }
                const url = new URL(urlStr);
                const client = url.protocol === 'https:' ? https : http;
                const options = {
                    method: 'HEAD',
                    hostname: url.hostname,
                    port: parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
                    path: url.pathname + url.search,
                    timeout: 10000,
                    rejectUnauthorized: !model.allowUnauthorized,
                };
                if (model.apiKey && model.apiKey !== 'none') {
                    let key = model.apiKey;
                    try {
                        key = (0, cryptoStore_1.decryptString)(model.apiKey);
                    }
                    catch {
                        /* unencrypted key fallback */
                    }
                    if (model.provider === 'anthropic') {
                        options.headers = {
                            'x-api-key': key,
                            'anthropic-version': '2025-04-01',
                        };
                    }
                    else if (model.provider === 'google') {
                        options.headers = {
                            'x-goog-api-key': key,
                        };
                    }
                    else {
                        options.headers = {
                            Authorization: `Bearer ${key}`,
                        };
                    }
                }
                const req = client.request(options, (res) => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
                        resolve({
                            success: true,
                            status: res.statusCode,
                            message: `Endpoint reachable (HTTP ${res.statusCode})`,
                        });
                    }
                    else {
                        const guidance = {
                            401: 'Authentication rejected (HTTP 401) — check your API key and provider configuration',
                            403: 'Access denied (HTTP 403) — check provider permissions, account eligibility, and location availability',
                            404: 'Endpoint not found (HTTP 404) — check the API URL and provider model/route availability',
                            405: 'Endpoint does not support HEAD (HTTP 405) — this connection test cannot verify model access',
                            429: 'Rate limited (HTTP 429) — check provider quota and retry later',
                        };
                        resolve({
                            success: false,
                            status: res.statusCode,
                            error: guidance[res.statusCode || 0] || `Server returned HTTP ${res.statusCode}`,
                        });
                    }
                    res.resume();
                });
                req.setTimeout(10000, () => {
                    req.destroy();
                    resolve({ success: false, error: 'Connection timed out after 10 seconds' });
                });
                req.on('error', (err) => {
                    let message = err.message;
                    if (message.includes('ECONNREFUSED')) {
                        message = 'Connection refused — server may not be running';
                    }
                    else if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
                        message = 'Host not found — check the API URL';
                    }
                    else if (message.includes('CERT') || message.includes('certificate') || message.includes('SSL')) {
                        message = 'SSL/TLS error — try enabling "allowUnauthorized" for self-signed certs';
                    }
                    resolve({ success: false, error: message });
                });
                req.end();
            }
            catch (err) {
                resolve({ success: false, error: `Invalid URL: ${err.message}` });
            }
        });
    });
}
//# sourceMappingURL=customModelIpc.js.map