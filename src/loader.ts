import type { ExecFileOptions } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process');
import { app, ipcMain, session } from 'electron';
import { startProxy, getProxyPort } from './proxy';
import { setupCustomModelIpc } from './customModelIpc';

let proxyPort = 0;

// Start the local proxy server as early as possible
const startProxyPromise = startProxy()
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
(childProcess as any).spawn = function (command: string, args?: string[], options?: any) {
  const isLanguageServer =
    (typeof command === 'string' && command.includes('language_server')) ||
    (Array.isArray(args) &&
      args.some(
        (a) =>
          typeof a === 'string' &&
          (a === '--standalone' || a.includes('language_server') || a.includes('LanguageServer')),
      ));

  if (isLanguageServer && Array.isArray(args)) {
    const port = proxyPort || getProxyPort() || 50999;
    const proxyUrl = `http://127.0.0.1:${port}`;
    const patchedArgs = [...args];

    // 1. Rewrite --api_server_url
    const apiIdx = patchedArgs.indexOf('--api_server_url');
    if (apiIdx !== -1 && apiIdx + 1 < patchedArgs.length) {
      patchedArgs[apiIdx + 1] = proxyUrl;
    } else {
      patchedArgs.push('--api_server_url', proxyUrl);
    }

    // 2. Rewrite --cloud_code_endpoint
    const ccIdx = patchedArgs.indexOf('--cloud_code_endpoint');
    if (ccIdx !== -1 && ccIdx + 1 < patchedArgs.length) {
      patchedArgs[ccIdx + 1] = proxyUrl;
    } else {
      patchedArgs.push('--cloud_code_endpoint', proxyUrl);
    }

    // 3. Ensure --inference_api_server_url
    const infIdx = patchedArgs.indexOf('--inference_api_server_url');
    if (infIdx !== -1 && infIdx + 1 < patchedArgs.length) {
      patchedArgs[infIdx + 1] = proxyUrl;
    } else {
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
    const proc = originalSpawn.call(this, command, patchedArgs as any, options);

    // Wrap stdin.end to prevent premature EOF exit when running in daemon mode
    if (proc.stdin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proc.stdin.end = function () {
        return proc.stdin;
      } as any;
    }

    return proc;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return originalSpawn.apply(this, [command, args, options] as any);
};

// ─── Intercept child_process.execFile to bypass WSL probing on Windows ───────

if (typeof process !== 'undefined' && process.platform === 'win32' && typeof childProcess.execFile === 'function') {
  const isWslDisabled = () => {
    if (typeof process === 'undefined') return false;
    const env = process.env || {};
    const argv = Array.isArray(process.argv) ? process.argv : [];
    return (
      env.ANTIGRAVITY_DISABLE_WSL === '1' ||
      env.AG_DISABLE_WSL === '1' ||
      argv.includes('--no-wsl') ||
      argv.some((arg) => typeof arg === 'string' && arg.startsWith('--wsl-distro='))
    );
  };

  const originalExecFile = childProcess.execFile;

  const getEmptyOutput = (options?: ExecFileOptions | null) =>
    options && options.encoding === 'buffer' ? Buffer.alloc(0) : '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (childProcess as any).execFile = function (file: string, ...args: any[]) {
    if (isWslDisabled() && typeof file === 'string' && file.toLowerCase().includes('wsl.exe')) {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as ExecFileOptions | undefined;
      const empty = getEmptyOutput(options);

      if (callback) {
        process.nextTick(() => callback(null, empty, empty));
        return new childProcess.ChildProcess();
      }
    }
    return originalExecFile.apply(this, [file, ...args]);
  };

  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  if ((originalExecFile as any)[promisifyCustom]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (childProcess as any).execFile[promisifyCustom] = function (file: string, ...args: any[]) {
      if (isWslDisabled() && typeof file === 'string' && file.toLowerCase().includes('wsl.exe')) {
        const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as ExecFileOptions | undefined;
        const empty = getEmptyOutput(options);
        return Promise.resolve({ stdout: empty, stderr: empty });
      }
      return (originalExecFile as any)[promisifyCustom].apply(this, [file, ...args]);
    };
  }
}

// ─── Setup IPC & WebRequest Interception ──────────────────────────────────────

// Register custom model storage & connection test IPC handlers
setupCustomModelIpc(ipcMain);

// Intercept frontend requests once Electron session is ready
app.whenReady().then(() => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      // Prevent frontend from resetting CloudCode URL away from our proxy
      if (details.url.includes('SetCloudCodeURL')) {
        console.log(`[Loader] Blocked SetCloudCodeURL: ${details.url}`);
        callback({ cancel: true });
        return;
      }

      // Route model listing through local proxy to inject custom models
      if (details.url.includes('LanguageServerService/GetAvailableModels')) {
        const redirectWithPort = (port: number) => {
          const redirectTarget = `http://127.0.0.1:${port}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`;
          console.log(`[Loader] Redirecting GetAvailableModels to proxy: ${redirectTarget}`);
          (callback as (opts: { cancel?: boolean; redirectURL?: string }) => void)({
            redirectURL: redirectTarget,
          });
        };

        const readyPort = proxyPort || getProxyPort();
        if (readyPort > 0) {
          redirectWithPort(readyPort);
          return;
        }
        // Дожидаемся завершения старта прокси при холодном запуске Electron, чтобы не попасть в гонку порта.
        startProxyPromise.then((startedPort) => {
          redirectWithPort(startedPort || getProxyPort() || 50999);
        });
        return;
      }

      callback({});
    });
  } catch (err) {
    console.error('[Loader] Failed to register webRequest onBeforeRequest interceptor:', err);
  }
});

// ─── Delegate to Official Main Process ───────────────────────────────────────

// Load the vendor's untouched main process
require('./main.js');
