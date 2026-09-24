import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Handler = (...args: unknown[]) => unknown;
type State = { type: string; update?: { version: string } };

// Execute the production CommonJS modules with an explicit Electron boundary.
// No app, updater, shell, filesystem write, or network operation runs in this fixture.
const compiled = new Map(
  ['updater', 'ipcHandlers', 'preload', 'customModelIpc'].map((name) => [
    name,
    ts.transpileModule(readFileSync(path.resolve('src', `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  ]),
);

function loadModule(name: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, Handler> };
  runInNewContext(compiled.get(name)!, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    process,
    console,
    URL,
    ...globals,
  });
  return module.exports;
}

function createFixture() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Handler>>();
  const exposed: Record<string, Record<string, Handler>> = {};
  const stat = vi.fn();
  const showOpenDialog = vi.fn();
  const showItemInFolder = vi.fn();
  let responseStatus = 200;
  const request = vi.fn((_options: unknown, onResponse: (response: unknown) => void) => ({
    setTimeout: vi.fn(),
    on: vi.fn(),
    end: () => onResponse({ statusCode: responseStatus, resume: vi.fn() }),
  }));
  const idePath = path.resolve('fixture', 'Antigravity IDE');
  const send = vi.fn((channel: string, ...args: unknown[]) => {
    for (const callback of listeners.get(channel) || []) callback({}, ...args);
  });
  const electron = {
    app: { isPackaged: false },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
    dialog: { showOpenDialog },
    shell: { showItemInFolder },
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for ${channel}`);
        return handler({}, ...args);
      },
      on: (channel: string, callback: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(callback);
      },
      removeListener: (channel: string, callback: Handler) => listeners.get(channel)?.delete(callback),
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, Handler>) => {
        exposed[name] = api;
      },
    },
    webFrame: {},
  };
  const dependencies = {
    electron,
    path,
    child_process: {},
    'electron-updater': { autoUpdater: {} },
    'electron-log/main': {},
    'fs/promises': { stat },
    http: { request },
    https: { request },
    './cryptoStore': {},
    './customScheme': { extensionAuthorities: new Map() },
    './tray': {},
    './ideInstall/constants': { getIdeInstallPath: () => idePath },
  };
  const customModelIpc = loadModule('customModelIpc', dependencies);
  const updater = loadModule('updater', dependencies);
  const ipc = loadModule('ipcHandlers', { ...dependencies, './updater': updater, './customModelIpc': customModelIpc });
  ipc.registerIpcHandlers({});
  loadModule('preload', dependencies, { window: { addEventListener: vi.fn() } });
  return {
    exposed,
    updater,
    stat,
    showOpenDialog,
    showItemInFolder,
    idePath,
    send,
    request,
    setResponseStatus: (status: number) => {
      responseStatus = status;
    },
  };
}

describe('renderer compatibility IPC contracts', () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(() => {
    fixture = createFixture();
  });

  it('resolves the renderer startup state before an updater event has occurred', async () => {
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'idle' });
  });

  it('recovers missed updater events and returns independent state snapshots', async () => {
    const state = { type: 'ready', update: { version: '2.12.2' } };
    fixture.updater.broadcastState(state);
    state.update.version = 'mutated input';
    const snapshot = (await fixture.exposed.electronUpdater.getState()) as State;
    expect(snapshot).toEqual({ type: 'ready', update: { version: '2.12.2' } });
    snapshot.update!.version = 'mutated snapshot';
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({
      type: 'ready',
      update: { version: '2.12.2' },
    });
  });

  it('preserves subscriptions, unsubscribe, and the existing apply API', async () => {
    const changed = vi.fn();
    const unsubscribe = fixture.exposed.electronUpdater.onStateChanged(changed) as () => void;
    await fixture.exposed.electronUpdater.applyUpdate();
    expect(changed).toHaveBeenCalledWith({ type: 'ready' });
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'ready' });
    unsubscribe();
    fixture.updater.broadcastState({ type: 'idle' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('returns all selected workspaces while preserving the singular API', async () => {
    const folders = [path.resolve('first folder'), path.resolve('second folder')];
    fixture.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: folders });
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toEqual(folders);
    expect(fixture.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: 'Open workspaces',
    });
    await expect(fixture.exposed.dialog.showOpenDialog()).resolves.toBe(folders[0]);
    expect(fixture.showOpenDialog.mock.lastCall![0].properties).not.toContain('multiSelections');
  });

  it.each([
    { canceled: true, filePaths: [path.resolve('ignored')] },
    { canceled: false, filePaths: [] },
  ])('returns undefined for a canceled or empty folder selection: %j', async (result) => {
    fixture.showOpenDialog.mockResolvedValue(result);
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toBeUndefined();
  });

  it('reveals an existing absolute path without executing a command', async () => {
    const filename = path.resolve('fixture', 'folder with spaces', 'report.txt');
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).resolves.toBeUndefined();
    expect(fixture.stat).toHaveBeenCalledWith(filename);
    expect(fixture.showItemInFolder).toHaveBeenCalledWith(filename);
  });

  it.each(['', '   ', 'relative/path', 'https://example.com/file', `bad\0path`, null, 42])(
    'rejects an invalid reveal argument before accessing the filesystem: %j',
    async (filename) => {
      await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).rejects.toThrow(
        'absolute filesystem path',
      );
      expect(fixture.stat).not.toHaveBeenCalled();
      expect(fixture.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('does not reveal a missing file', async () => {
    fixture.stat.mockRejectedValue(Object.assign(new Error('File not found'), { code: 'ENOENT' }));
    await expect(fixture.exposed.electronNative.revealInFilePicker(path.resolve('missing'))).rejects.toThrow(
      'File not found',
    );
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reports an existing IDE installation directory', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => true });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(true);
    expect(fixture.stat).toHaveBeenCalledWith(fixture.idePath);
  });

  it('does not mistake a file for an IDE installation', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  it.each(['ENOENT', 'EACCES'])('keeps startup working when IDE lookup returns %s', async (code) => {
    fixture.stat.mockRejectedValue(Object.assign(new Error(code), { code }));
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  it.each([
    [401, 'Authentication rejected'],
    [403, 'Access denied'],
    [404, 'Endpoint not found'],
    [405, 'cannot verify model access'],
    [429, 'Rate limited'],
    [500, 'Server returned HTTP 500'],
  ])('does not report HTTP %i as a successful model connection', async (status, message) => {
    fixture.setResponseStatus(status as number);
    await expect(
      fixture.exposed.nativeStorage.testModelConnection({
        apiUrl: 'https://provider.example/v1',
        provider: 'openai',
      }),
    ).resolves.toEqual({ success: false, status, error: expect.stringContaining(message as string) });
    expect(fixture.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'HEAD',
        hostname: 'provider.example',
        path: '/v1/chat/completions',
        rejectUnauthorized: true,
      }),
      expect.any(Function),
    );
  });

  it.each([200, 204, 301])(
    'describes HTTP %i as endpoint reachability, without claiming generation succeeded',
    async (status) => {
      fixture.setResponseStatus(status);
      await expect(
        fixture.exposed.nativeStorage.testModelConnection({
          apiUrl: 'https://provider.example/v1',
          provider: 'openai',
        }),
      ).resolves.toEqual({ success: true, status, message: `Endpoint reachable (HTTP ${status})` });
    },
  );
});
