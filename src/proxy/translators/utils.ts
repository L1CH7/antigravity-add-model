/**
 * Общие вспомогательные функции для трансляторов протоколов.
 */

import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GeminiParameterProperties {
  type?: string;
  properties?: GeminiParameterProperties;
  items?: GeminiParameterProperties;
  [key: string]: unknown;
}

export interface ToolCallArgs {
  CommandLine?: string;
  Cwd?: string;
  [key: string]: unknown;
}

export interface TranslatedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd?: string;
}

export interface MatchResult {
  Filename: string;
  LineNumber: number;
  LineContent: string;
}

export interface DirectoryItem {
  name: string;
  isDir: boolean;
  sizeBytes?: number;
}

export interface FileListResponse {
  files?: DirectoryItem[];
  children?: DirectoryItem[];
  content?: string;
  CodeContent?: string;
}

export type ToolResponse = string | DirectoryItem[] | MatchResult[] | FileListResponse;

/** Tool declarations belong to one request, never to a shared model/session cache. */
export type ToolSchemas = ReadonlyMap<string, unknown>;

export function collectToolSchemas(body: unknown): ToolSchemas {
  const schemas = new Map<string, unknown>();
  if (!body || typeof body !== 'object') return schemas;

  // Antigravity кладёт объявления внутрь вложенного request; верхний уровень
  // используется другими вызывающими и сохраняется для совместимости.
  const outer = body as { tools?: unknown; request?: { tools?: unknown } };
  const candidates = [outer.tools, outer.request?.tools];
  let tools: unknown;
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      tools = candidate;
      break;
    }
  }
  if (!Array.isArray(tools)) return schemas;

  for (const group of tools) {
    if (!group || !Array.isArray(group.functionDeclarations)) continue;
    for (const declaration of group.functionDeclarations) {
      if (!declaration || typeof declaration.name !== 'string') continue;
      schemas.set(
        declaration.name,
        schemas.has(declaration.name) ? undefined : (declaration.parametersJsonSchema ?? declaration.parameters),
      );
    }
  }
  return schemas;
}

// ─── Tool Parameter Normalization ──────────────────────────────────────────

const TOOL_PARAM_NORMALIZATION: Record<string, { primaryKey: string; aliases: string[] }> = {
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
  'view_file.StartLine': {
    primaryKey: 'StartLine',
    aliases: ['start_line', 'startLine', 'from_line', 'fromLine', 'line_start', 'lineStart'],
  },
  'view_file.EndLine': {
    primaryKey: 'EndLine',
    aliases: ['end_line', 'endLine', 'to_line', 'toLine', 'line_end', 'lineEnd'],
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
  write_to_file: {
    primaryKey: 'TargetFile',
    aliases: [
      'AbsolutePath',
      'absolute_path',
      'absolutePath',
      'target_file',
      'targetFile',
      'path',
      'file_path',
      'filePath',
      'file',
      'FilePath',
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
  'read_file.StartLine': {
    primaryKey: 'StartLine',
    aliases: ['start_line', 'startLine', 'from_line', 'fromLine', 'line_start', 'lineStart'],
  },
  'read_file.EndLine': {
    primaryKey: 'EndLine',
    aliases: ['end_line', 'endLine', 'to_line', 'toLine', 'line_end', 'lineEnd'],
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

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Resolve explicit legacy aliases only. Live declarations take precedence over
 * historical tool signatures; arbitrary values must never become file paths.
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown> | null | undefined,
  schemas?: ToolSchemas,
): Record<string, unknown> {
  if (!args || typeof args !== 'object') return args || {};

  // Handle array args
  if (Array.isArray(args)) {
    const config = hasOwn(TOOL_PARAM_NORMALIZATION, name) ? TOOL_PARAM_NORMALIZATION[name] : undefined;
    if (!schemas && config && args.length > 0 && typeof args[0] === 'string') {
      return { [config.primaryKey]: args[0] };
    }
    return {};
  }

  const config = hasOwn(TOOL_PARAM_NORMALIZATION, name) ? TOOL_PARAM_NORMALIZATION[name] : undefined;
  const normalized = { ...args };
  if (!config) return normalized;
  let properties: Record<string, unknown> | undefined;
  if (schemas) {
    const schema = schemas.get(name);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return normalized;
    const declared = (schema as { properties?: unknown }).properties;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return normalized;
    properties = declared as Record<string, unknown>;
  }
  const rules = [
    config,
    ...Object.entries(TOOL_PARAM_NORMALIZATION)
      .filter(([key]) => key.startsWith(name + '.'))
      .map(([, value]) => value),
  ];
  for (const [key, value] of Object.entries(args)) {
    // A valid caller-defined property is never renamed to a historical alias.
    if (properties && hasOwn(properties, key)) continue;
    const rule = rules.find((candidate) => candidate.aliases.includes(key));
    if (!rule || (properties && !hasOwn(properties, rule.primaryKey))) continue;
    // Keep an explicit canonical argument even if a conflicting alias follows it.
    if (!hasOwn(normalized, rule.primaryKey)) normalized[rule.primaryKey] = value;
    delete normalized[key];
  }
  return normalized;
}

// ─── Utility Functions ────────────────────────────────────────────────────

/**
 * Recursively converts Gemini parameter types (UPPERCASE) to lowercase format.
 * Gemini uses uppercase (STRING, NUMBER); OpenAI/Anthropic need lowercase.
 */
export function fixParamTypes(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const key of Object.keys(properties)) {
    const val = properties[key];
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.type === 'string') {
        obj.type = (obj.type as string).toLowerCase();
      }
      if (obj.properties && typeof obj.properties === 'object') {
        fixParamTypes(obj.properties as Record<string, unknown>);
      }
      if (obj.items && typeof obj.items === 'object') {
        const items = obj.items as Record<string, unknown>;
        if (typeof items.type === 'string') {
          items.type = (items.type as string).toLowerCase();
        }
        if (items.properties && typeof items.properties === 'object') {
          fixParamTypes(items.properties as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Извлекает декларации инструментов из Gemini tools в нормализованном виде
 * (с копированием схемы и приведением типов параметров к нижнему регистру).
 */
export function extractGeminiToolDeclarations(
  geminiTools: unknown,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  if (!geminiTools || !Array.isArray(geminiTools)) return [];
  const extracted: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
  for (const toolGroup of geminiTools) {
    if (!toolGroup || typeof toolGroup !== 'object') continue;
    const decls = (toolGroup as { functionDeclarations?: unknown }).functionDeclarations;
    if (!Array.isArray(decls)) continue;
    for (const func of decls) {
      if (!func || typeof func !== 'object') continue;
      const fn = func as {
        name?: string;
        description?: string;
        parametersJsonSchema?: unknown;
        parameters?: unknown;
      };
      if (!fn.name) continue;
      const declaration = fn.parametersJsonSchema ?? fn.parameters;
      const params = declaration
        ? (JSON.parse(JSON.stringify(declaration)) as Record<string, unknown>)
        : { type: 'object', properties: {} };
      if (params.type && typeof params.type === 'string') {
        params.type = params.type.toLowerCase();
      }
      if (params.properties && typeof params.properties === 'object') {
        fixParamTypes(params.properties as Record<string, unknown>);
      }
      extracted.push({
        name: fn.name,
        description: fn.description || '',
        parameters: params,
      });
    }
  }
  return extracted;
}

/**
 * Безопасно разбирает аргументы вызова инструмента из JSON-строки или объекта.
 */
export function parseToolCallArgs(rawArgs: unknown): ToolCallArgs {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? (parsed as ToolCallArgs) : {};
    } catch (e) {
      log.debug('[Proxy] Tool call args parse fallback:', (e as Error).message);
      return {};
    }
  }
  return typeof rawArgs === 'object' ? (rawArgs as ToolCallArgs) : {};
}

/**
 * Сохраняет оригинальное имя и параметры вызова инструмента без подмены.
 * Команды терминала (включая ls, cat, grep и т.д.) передаются в run_command как есть.
 */
export function translateToolCallToNative(
  name: string,
  args: ToolCallArgs,
  _schemas?: ToolSchemas,
): TranslatedToolCall {
  return { name, args: (args || {}) as Record<string, unknown> };
}

/**
 * Преобразует ответ инструмента в строку для передачи модели без искажения структуры.
 */
export function formatTranslatedResponse(_translatedInfo: TranslatedCallInfo, responseData: unknown): string {
  return typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? '');
}
