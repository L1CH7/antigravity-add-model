"use strict";
/**
 * Shared translator utility functions.
 * Extracted from proxy.js to avoid duplication across translator modules.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeToolArgs = normalizeToolArgs;
exports.fixParamTypes = fixParamTypes;
exports.translateToolCallToNative = translateToolCallToNative;
exports.formatTranslatedResponse = formatTranslatedResponse;
const electron_log_1 = __importDefault(require("electron-log"));
// ─── Tool Parameter Normalization ──────────────────────────────────────────
const TOOL_PARAM_NORMALIZATION = {
    view_file: {
        primaryKey: 'AbsolutePath',
        aliases: [
            'absolute_path',
            'absolutePath',
            'path',
            'file_path',
            'filePath',
            'file',
            'filename',
            'FilePath',
            'FileName',
            'target',
            'source',
            'input',
            'uri',
        ],
    },
    list_dir: {
        primaryKey: 'DirectoryPath',
        aliases: [
            'directory_path',
            'directoryPath',
            'path',
            'dir_path',
            'dirPath',
            'dir',
            'directory',
            'folder',
            'FolderPath',
            'folder_path',
            'target',
            'root',
            'base',
        ],
    },
    grep_search: {
        primaryKey: 'Query',
        aliases: [
            'query',
            'search',
            'SearchQuery',
            'search_query',
            'searchQuery',
            'pattern',
            'Pattern',
            'regex',
            'Regex',
            'term',
            'keyword',
            'text',
            'needle',
        ],
    },
    'grep_search.SearchPath': {
        primaryKey: 'SearchPath',
        aliases: [
            'search_path',
            'searchPath',
            'path',
            'directory',
            'DirectoryPath',
            'directory_path',
            'folder',
            'dir',
            'root',
            'base',
        ],
    },
    replace_file_content: {
        primaryKey: 'TargetFile',
        aliases: [
            'target_file',
            'targetFile',
            'file',
            'AbsolutePath',
            'absolute_path',
            'filePath',
            'file_path',
            'path',
            'FilePath',
            'target',
            'filename',
            'source',
        ],
    },
    write_file: {
        primaryKey: 'AbsolutePath',
        aliases: [
            'absolute_path',
            'absolutePath',
            'path',
            'file_path',
            'filePath',
            'file',
            'filename',
            'FilePath',
            'FileName',
            'target_file',
            'targetFile',
            'target',
            'dest',
            'destination',
        ],
    },
    run_command: {
        primaryKey: 'CommandLine',
        aliases: [
            'command_line',
            'commandLine',
            'cmd',
            'command',
            'Command',
            'Cmd',
            'shell_command',
            'shellCommand',
            'script',
            'exec',
            'execute',
        ],
    },
    'run_command.Cwd': {
        primaryKey: 'Cwd',
        aliases: ['cwd', 'working_dir', 'workingDirectory', 'working_directory', 'dir', 'directory', 'path', 'folder'],
    },
    read_file: {
        primaryKey: 'AbsolutePath',
        aliases: [
            'absolute_path',
            'absolutePath',
            'path',
            'file_path',
            'filePath',
            'file',
            'filename',
            'FilePath',
            'FileName',
            'target',
            'source',
            'input',
        ],
    },
    search_files: {
        primaryKey: 'SearchPath',
        aliases: [
            'search_path',
            'searchPath',
            'path',
            'directory',
            'DirectoryPath',
            'directory_path',
            'folder',
            'dir',
            'root',
            'base',
        ],
    },
    create_directory: {
        primaryKey: 'DirectoryPath',
        aliases: ['directory_path', 'directoryPath', 'path', 'dir_path', 'dirPath', 'dir', 'folder', 'target', 'name'],
    },
    delete_file: {
        primaryKey: 'AbsolutePath',
        aliases: [
            'absolute_path',
            'absolutePath',
            'path',
            'file_path',
            'filePath',
            'file',
            'filename',
            'FilePath',
            'target',
        ],
    },
    move_file: {
        primaryKey: 'SourcePath',
        aliases: [
            'source_path',
            'sourcePath',
            'source',
            'from',
            'src',
            'path',
            'file_path',
            'filePath',
            'AbsolutePath',
            'absolute_path',
        ],
    },
    'move_file.DestinationPath': {
        primaryKey: 'DestinationPath',
        aliases: ['destination_path', 'destinationPath', 'dest', 'destination', 'to', 'dst', 'target'],
    },
};
/**
 * Normalizes parameter names from external models to match Antigravity's expected PascalCase format.
 */
function normalizeToolArgs(name, args) {
    if (!args || typeof args !== 'object')
        return args || {};
    // Handle array args
    if (Array.isArray(args)) {
        const config = TOOL_PARAM_NORMALIZATION[name];
        if (config && args.length > 0 && typeof args[0] === 'string') {
            return { [config.primaryKey]: args[0] };
        }
        return {};
    }
    const config = TOOL_PARAM_NORMALIZATION[name];
    if (!config) {
        return args;
    }
    const normalized = {};
    const usedKeys = new Set();
    for (const [key, value] of Object.entries(args)) {
        let matched = false;
        if (key === config.primaryKey || (config.aliases && config.aliases.includes(key))) {
            normalized[config.primaryKey] = value;
            usedKeys.add(key);
            matched = true;
        }
        if (!matched) {
            const subConfigKey = name + '.' + key;
            const subConfig = TOOL_PARAM_NORMALIZATION[subConfigKey];
            if (subConfig) {
                normalized[subConfig.primaryKey] = value;
                usedKeys.add(key);
                matched = true;
            }
        }
        if (!matched) {
            for (const [ck, cv] of Object.entries(TOOL_PARAM_NORMALIZATION)) {
                if (ck.startsWith(name + '.') && cv.aliases && cv.aliases.includes(key)) {
                    normalized[cv.primaryKey] = value;
                    usedKeys.add(key);
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            normalized[key] = value;
        }
    }
    if (!normalized[config.primaryKey]) {
        const unassigned = Object.entries(args).filter(([k]) => !usedKeys.has(k));
        let found = unassigned.find(([, v]) => typeof v === 'string' && (v.includes('/') || v.includes('\\') || v.includes('.')));
        if (!found)
            found = unassigned.find(([, v]) => typeof v === 'string' && v.length > 0);
        if (!found) {
            found = Object.entries(args).find(([, v]) => typeof v === 'string' && (v.includes('/') || v.includes('\\') || v.includes('.')));
            if (!found)
                found = Object.entries(args).find(([, v]) => typeof v === 'string' && v.length > 0);
        }
        if (found) {
            normalized[config.primaryKey] = found[1];
            electron_log_1.default.info(`[Utils] normalizeToolArgs fallback: "${name}" extracted ${config.primaryKey}=${found[1]} from key "${found[0]}"`);
        }
        else {
            electron_log_1.default.warn(`[Utils] normalizeToolArgs: "${name}" could not find value for "${config.primaryKey}". args=${JSON.stringify(args)}`);
        }
    }
    return normalized;
}
function applyUniversalPathFallback(args) {
    const result = { ...args };
    const aliasMap = {
        path: 'AbsolutePath',
        file_path: 'AbsolutePath',
        filePath: 'AbsolutePath',
        file: 'AbsolutePath',
        filename: 'AbsolutePath',
        target: 'AbsolutePath',
        directory_path: 'DirectoryPath',
        directoryPath: 'DirectoryPath',
        dir: 'DirectoryPath',
        directory: 'DirectoryPath',
        folder: 'DirectoryPath',
        target_file: 'TargetFile',
        targetFile: 'TargetFile',
        source: 'SourcePath',
        sourcePath: 'SourcePath',
        source_path: 'SourcePath',
        dest: 'DestinationPath',
        destination: 'DestinationPath',
    };
    for (const [key, value] of Object.entries(args)) {
        const mappedKey = aliasMap[key];
        if (mappedKey) {
            result[mappedKey] = value;
            delete result[key];
            return result;
        }
    }
    for (const [, value] of Object.entries(args)) {
        if (typeof value === 'string' && (value.includes('/') || value.includes('\\') || value.includes('.'))) {
            result['AbsolutePath'] = value;
            return result;
        }
    }
    return result;
}
// ─── Utility Functions ────────────────────────────────────────────────────
/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
function fixParamTypes(properties) {
    if (!properties)
        return;
    for (const key of Object.keys(properties)) {
        const val = properties[key];
        if (val && typeof val === 'object') {
            const obj = val;
            if (typeof obj.type === 'string') {
                obj.type = obj.type.toLowerCase();
            }
            if (obj.properties && typeof obj.properties === 'object') {
                fixParamTypes(obj.properties);
            }
            if (obj.items && typeof obj.items === 'object') {
                const items = obj.items;
                if (typeof items.type === 'string') {
                    items.type = items.type.toLowerCase();
                }
                if (items.properties && typeof items.properties === 'object') {
                    fixParamTypes(items.properties);
                }
            }
        }
    }
}
/**
 * Translates generic shell/terminal commands (run_command) into native Antigravity file tools.
 */
function translateToolCallToNative(name, args) {
    return { name, args: args };
}
function formatTranslatedResponse(translatedInfo, responseData) {
    const { translatedName, cmd } = translatedInfo;
    electron_log_1.default.info(`[Proxy] Formatting native response back to CLI for translated tool "${translatedName}" (Cmd: "${cmd}")`);
    if (translatedName === 'list_dir') {
        if (Array.isArray(responseData)) {
            return responseData
                .map((item) => {
                const typeIndicator = item.isDir ? '<DIR>' : '     ';
                const sizeStr = item.isDir ? '' : ` (${item.sizeBytes || 0} bytes)`;
                return `${typeIndicator}  ${item.name}${sizeStr}`;
            })
                .join('\n');
        }
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            const items = data.files || data.children || [];
            if (Array.isArray(items)) {
                return items.map((item) => `${item.isDir ? '<DIR>' : '     '}  ${item.name}`).join('\n');
            }
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'view_file') {
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            return data.content || data.CodeContent || JSON.stringify(responseData);
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'grep_search') {
        if (Array.isArray(responseData)) {
            return responseData
                .map((match) => `${match.Filename}:${match.LineNumber}:${match.LineContent}`)
                .join('\n');
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    if (translatedName === 'write_file') {
        if (responseData && typeof responseData === 'object') {
            const data = responseData;
            if (data.success)
                return `File written successfully: ${data.path || 'unknown'}`;
            return `Failed to write file: ${data.error || 'Unknown error'}`;
        }
        return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    }
    return typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
}
//# sourceMappingURL=utils.js.map