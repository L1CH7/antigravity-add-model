"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process');
const electron_1 = require("electron");
const proxy_1 = require("./proxy");
const customModelIpc_1 = require("./customModelIpc");
let proxyPort = 0;
// Start the local proxy server as early as possible
(0, proxy_1.startProxy)()
    .then((port) => {
    proxyPort = port;
    console.log(`[Loader] Local proxy started on port ${port}`);
    return port;
})
    .catch((err) => {
    console.error('[Loader] Failed to start local proxy:', err);
    return 0;
});
// ─── Intercept child_process.spawn for language_server ───────────────────────
const originalSpawn = childProcess.spawn;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
childProcess.spawn = function (command, args, options) {
    const isLanguageServer = (typeof command === 'string' && command.includes('language_server')) ||
        (Array.isArray(args) &&
            args.some((a) => typeof a === 'string' &&
                (a === '--standalone' || a.includes('language_server') || a.includes('LanguageServer'))));
    if (isLanguageServer && Array.isArray(args)) {
        const port = proxyPort || (0, proxy_1.getProxyPort)() || 50999;
        const proxyUrl = `http://127.0.0.1:${port}`;
        const patchedArgs = [...args];
        // 1. Rewrite --api_server_url
        const apiIdx = patchedArgs.indexOf('--api_server_url');
        if (apiIdx !== -1 && apiIdx + 1 < patchedArgs.length) {
            patchedArgs[apiIdx + 1] = proxyUrl;
        }
        else {
            patchedArgs.push('--api_server_url', proxyUrl);
        }
        // 2. Rewrite --cloud_code_endpoint
        const ccIdx = patchedArgs.indexOf('--cloud_code_endpoint');
        if (ccIdx !== -1 && ccIdx + 1 < patchedArgs.length) {
            patchedArgs[ccIdx + 1] = proxyUrl;
        }
        else {
            patchedArgs.push('--cloud_code_endpoint', proxyUrl);
        }
        // 3. Ensure --inference_api_server_url
        const infIdx = patchedArgs.indexOf('--inference_api_server_url');
        if (infIdx !== -1 && infIdx + 1 < patchedArgs.length) {
            patchedArgs[infIdx + 1] = proxyUrl;
        }
        else {
            patchedArgs.push('--inference_api_server_url', proxyUrl);
        }
        // 4. Ensure --persistent_mode=true
        if (!patchedArgs.some((a) => a.startsWith('--persistent_mode'))) {
            patchedArgs.push('--persistent_mode=true');
        }
        // 5. Ensure --disable_telemetry=true
        if (!patchedArgs.some((a) => a.startsWith('--disable_telemetry'))) {
            patchedArgs.push('--disable_telemetry=true');
        }
        console.log('[Loader] Intercepted language_server spawn, redirected endpoints to:', proxyUrl);
        // Execute underlying spawn with patched arguments
        const proc = originalSpawn.call(this, command, patchedArgs, options);
        // Wrap stdin.end to prevent premature EOF exit when running in daemon mode
        if (proc.stdin) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            proc.stdin.end = function () {
                return proc.stdin;
            };
        }
        return proc;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalSpawn.apply(this, [command, args, options]);
};
// ─── Setup IPC & WebRequest Interception ──────────────────────────────────────
// Register custom model storage & connection test IPC handlers
(0, customModelIpc_1.setupCustomModelIpc)(electron_1.ipcMain);
// Intercept frontend requests once Electron session is ready
electron_1.app.whenReady().then(() => {
    try {
        electron_1.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            // Prevent frontend from resetting CloudCode URL away from our proxy
            if (details.url.includes('SetCloudCodeURL')) {
                console.log(`[Loader] Blocked SetCloudCodeURL: ${details.url}`);
                callback({ cancel: true });
                return;
            }
            // Route model listing through local proxy to inject custom models
            if (details.url.includes('LanguageServerService/GetAvailableModels')) {
                const port = proxyPort || (0, proxy_1.getProxyPort)() || 50999;
                if (port > 0) {
                    const redirectTarget = `http://127.0.0.1:${port}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`;
                    console.log(`[Loader] Redirecting GetAvailableModels to proxy: ${redirectTarget}`);
                    callback({
                        redirectURL: redirectTarget,
                    });
                    return;
                }
            }
            callback({});
        });
    }
    catch (err) {
        console.error('[Loader] Failed to register webRequest onBeforeRequest interceptor:', err);
    }
});
// ─── Delegate to Official Main Process ───────────────────────────────────────
// Load the vendor's untouched main process
require('./main.js');
//# sourceMappingURL=loader.js.map