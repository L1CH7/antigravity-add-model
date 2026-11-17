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
      process,
      Buffer,
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

  it('intercepts wsl.exe only when disabled and respects buffer/string encoding', async () => {
    const originalExecFile = vi.fn((file, ...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(null, 'real-wsl-output', '');
      return {} as any;
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    (originalExecFile as any)[promisifyCustom] = vi.fn(() => Promise.resolve({ stdout: 'real-wsl-output', stderr: '' }));

    const mockChildProcess = {
      spawn: vi.fn(() => ({ stdin: { end: vi.fn() } })),
      execFile: originalExecFile,
      ChildProcess: EventEmitter,
    };

    const dependencies: Record<string, unknown> = {
      child_process: mockChildProcess,
      electron: {
        app: { whenReady: () => new Promise(() => {}), getAppPath: () => '/mock/app' },
        ipcMain: { handle: vi.fn() },
        session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
      },
      './proxy': { startProxy: () => Promise.resolve(50999), getProxyPort: () => 50999 },
      './customModelIpc': { setupCustomModelIpc: vi.fn() },
      './main.js': vi.fn(),
    };

    const fakeProcess = {
      platform: 'win32',
      env: { ANTIGRAVITY_DISABLE_WSL: '1' } as Record<string, string>,
      argv: ['node', 'loader.js'],
      nextTick: process.nextTick,
    };

    runInNewContext(source, {
      module: { exports: {} },
      exports: {},
      process: fakeProcess,
      Buffer,
      require: (id: string) => dependencies[id],
      console: { log: vi.fn(), error: vi.fn() },
    });

    // 1. When disabled and encoding is buffer -> returns Buffer.alloc(0)
    const bufRes = await new Promise<{ err: unknown; stdout: unknown; stderr: unknown }>((resolve) => {
      (mockChildProcess.execFile as any)('C:\\Windows\\System32\\wsl.exe', ['--list'], { encoding: 'buffer' }, (err: unknown, stdout: unknown, stderr: unknown) => {
        resolve({ err, stdout, stderr });
      });
    });
    expect(Buffer.isBuffer(bufRes.stdout)).toBe(true);
    expect((bufRes.stdout as Buffer).length).toBe(0);

    // 2. When disabled and encoding is utf8 (default) -> returns empty string ''
    const strRes = await new Promise<{ err: unknown; stdout: unknown; stderr: unknown }>((resolve) => {
      (mockChildProcess.execFile as any)('C:\\Windows\\System32\\wsl.exe', ['--list'], {}, (err: unknown, stdout: unknown, stderr: unknown) => {
        resolve({ err, stdout, stderr });
      });
    });
    expect(typeof strRes.stdout).toBe('string');
    expect(strRes.stdout).toBe('');

    // 3. Promisified custom returns proper types
    const promisified = (mockChildProcess.execFile as any)[promisifyCustom];
    const promBuf = await promisified('wsl.exe', ['--list'], { encoding: 'buffer' });
    expect(Buffer.isBuffer(promBuf.stdout)).toBe(true);
    expect(promBuf.stdout.length).toBe(0);

    const promStr = await promisified('wsl.exe', ['--list'], {});
    expect(typeof promStr.stdout).toBe('string');
    expect(promStr.stdout).toBe('');

    // 4. When WSL is NOT disabled -> passes through to originalExecFile
    fakeProcess.env.ANTIGRAVITY_DISABLE_WSL = '0';
    (mockChildProcess.execFile as any)('C:\\Windows\\System32\\wsl.exe', ['--list'], () => {});
    expect(originalExecFile).toHaveBeenCalledTimes(1);

    // 5. Explicit distro flag does NOT disable WSL, whereas empty --wsl-distro= does
    fakeProcess.argv = ['node', 'loader.js', '--wsl-distro=Ubuntu-22.04'];
    (mockChildProcess.execFile as any)('wsl.exe', ['--list'], () => {});
    expect(originalExecFile).toHaveBeenCalledTimes(2);

    fakeProcess.argv = ['node', 'loader.js', '--wsl-distro='];
    await new Promise<void>((resolve) => {
      const child = (mockChildProcess.execFile as any)('wsl.exe', ['--list']);
      let stdoutEnded = false;
      let exitedCode: number | null = null;
      child.stdout.on('end', () => {
        stdoutEnded = true;
      });
      child.on('exit', (code: number) => {
        exitedCode = code;
      });
      child.on('close', (code: number) => {
        expect(stdoutEnded).toBe(true);
        expect(exitedCode).toBe(0);
        expect(code).toBe(0);
        resolve();
      });
    });
    expect(originalExecFile).toHaveBeenCalledTimes(2);

    // 6. Executable in a directory containing "wsl.exe" in its path is NOT treated as wsl.exe
    fakeProcess.env.ANTIGRAVITY_DISABLE_WSL = '1';
    (mockChildProcess.execFile as any)('C:\\wsl.exe-tools\\helper.exe', ['--version'], () => {});
    expect(originalExecFile).toHaveBeenCalledTimes(3);
  });
});
