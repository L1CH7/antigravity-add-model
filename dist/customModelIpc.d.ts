import { ipcMain } from 'electron';
export interface CustomModelFileEntry {
    name: string;
    displayName?: string;
    description?: string;
    provider: string;
    apiKey: string;
    apiUrl: string;
    externalModelName: string;
    allowUnauthorized?: boolean;
    encrypted?: boolean;
    [key: string]: unknown;
}
export interface TestModelParams {
    apiUrl: string;
    provider: string;
    apiKey?: string;
    allowUnauthorized?: boolean;
}
export interface ConnectionTestResult {
    success: boolean;
    status?: number;
    message?: string;
    error?: string;
}
/**
 * Registers custom model storage and connectivity IPC handlers.
 * Safe to call in any Electron main process environment without overwriting native handlers.
 */
export declare function setupCustomModelIpc(ipc?: typeof ipcMain): void;
//# sourceMappingURL=customModelIpc.d.ts.map