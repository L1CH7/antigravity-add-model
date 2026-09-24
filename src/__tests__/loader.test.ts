import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(path.resolve('src/loader.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

describe('modular loader', () => {
  it('hooks child_process.spawn and injects proxy arguments into language_server', async () => {
    let interceptedArgs: string[] = [];
    const originalEnd = vi.fn();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdin: { end: originalEnd },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    const mockSpawn = vi.fn((_cmd: string, args: string[]) => {
      interceptedArgs = args;
      return fakeChild;
    });

    const mockChildProcess = {
      spawn: mockSpawn,
    };

    const mockIpcMain = {
      handle: vi.fn(),
    };

    let webRequestCallback: any;
    const mockSession = {
      defaultSession: {
        webRequest: {
          onBeforeRequest: vi.fn((cb) => {
            webRequestCallback = cb;
          }),
        },
      },
    };

    let whenReadyResolved: () => void;
    const whenReadyPromise = new Promise<void>((resolve) => {
      whenReadyResolved = resolve;
    });

    const mockApp = {
      whenReady: vi.fn(() => whenReadyPromise),
      getAppPath: () => '/mock/app',
    };

    const mockStartProxy = vi.fn(() => Promise.resolve(50999));
    const mockGetProxyPort = vi.fn(() => 50999);
    const mockSetupCustomModelIpc = vi.fn();
    const mockMainJs = vi.fn();

    const dependencies: Record<string, unknown> = {
      child_process: mockChildProcess,
      electron: {
        app: mockApp,
        ipcMain: mockIpcMain,
        session: mockSession,
      },
      './proxy': {
        startProxy: mockStartProxy,
        getProxyPort: mockGetProxyPort,
      },
      './customModelIpc': {
        setupCustomModelIpc: mockSetupCustomModelIpc,
      },
      './main.js': mockMainJs,
    };

    const module = { exports: {} };

    runInNewContext(source, {
      module,
      exports: module.exports,
      require: (id: string) => {
        if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
        return dependencies[id];
      },
      console: { log: vi.fn(), error: vi.fn() },
    });

    expect(mockStartProxy).toHaveBeenCalled();
    expect(mockSetupCustomModelIpc).toHaveBeenCalledWith(mockIpcMain);

    // Test spawn hooking
    const inputArgs = [
      '--standalone',
      '--api_server_url',
      'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint',
      'https://daily-cloudcode-pa.googleapis.com',
    ];

    const proc = (mockChildProcess.spawn as any)('/path/to/language_server', inputArgs, {});
    expect(mockSpawn).toHaveBeenCalled();

    const apiIdx = interceptedArgs.indexOf('--api_server_url');
    expect(apiIdx).toBeGreaterThan(-1);
    expect(interceptedArgs[apiIdx + 1]).toBe('http://127.0.0.1:50999');

    const ccIdx = interceptedArgs.indexOf('--cloud_code_endpoint');
    expect(ccIdx).toBeGreaterThan(-1);
    expect(interceptedArgs[ccIdx + 1]).toBe('http://127.0.0.1:50999');

    const infIdx = interceptedArgs.indexOf('--inference_api_server_url');
    expect(infIdx).toBeGreaterThan(-1);
    expect(interceptedArgs[infIdx + 1]).toBe('http://127.0.0.1:50999');

    expect(interceptedArgs).toContain('--persistent_mode=true');
    expect(interceptedArgs).toContain('--disable_telemetry=true');

    // Test that stdin.end does not kill stdin
    proc.stdin.end();
    expect(originalEnd).not.toHaveBeenCalled();

    // Test webRequest interception
    whenReadyResolved!();
    await whenReadyPromise;

    expect(mockSession.defaultSession.webRequest.onBeforeRequest).toHaveBeenCalled();

    // Test SetCloudCodeURL blocking
    const blockedCallback = vi.fn();
    webRequestCallback({ url: 'https://example.com/SetCloudCodeURL' }, blockedCallback);
    expect(blockedCallback).toHaveBeenCalledWith({ cancel: true });

    // Test GetAvailableModels redirection
    const redirectCallback = vi.fn();
    webRequestCallback({ url: 'https://example.com/LanguageServerService/GetAvailableModels' }, redirectCallback);
    expect(redirectCallback).toHaveBeenCalledWith({
      redirectURL: 'http://127.0.0.1:50999/GetAvailableModels?ls=https%3A%2F%2Fexample.com%2FLanguageServerService%2FGetAvailableModels',
    });
  });
});
