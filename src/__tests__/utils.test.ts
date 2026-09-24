/**
 * Unit tests for shared translator utilities (utils.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  fixParamTypes,
  normalizeToolArgs,
  translateToolCallToNative,
  formatTranslatedResponse,
} from '../proxy/translators/utils';

// ─── fixParamTypes ─────────────────────────────────────────────────────────

describe('fixParamTypes', () => {
  it('should lowercase top-level type', () => {
    const props: Record<string, unknown> = { type: { type: 'STRING', properties: {} } };
    fixParamTypes(props);
    expect((props.type as Record<string, string>).type).toBe('string');
  });

  it('should lowercase nested property types', () => {
    const props: Record<string, unknown> = {
      name: { type: 'STRING' },
      age: { type: 'NUMBER' },
    };
    fixParamTypes(props);
    expect((props.name as Record<string, string>).type).toBe('string');
    expect((props.age as Record<string, string>).type).toBe('number');
  });

  it('should handle items with type', () => {
    const props: Record<string, unknown> = {
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
    };
    fixParamTypes(props);
    const tags = props.tags as Record<string, unknown>;
    expect(tags.type).toBe('array');
    expect((tags.items as Record<string, string>).type).toBe('string');
  });

  it('should handle nested properties inside items', () => {
    const props: Record<string, unknown> = {
      results: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' } } },
      },
    };
    fixParamTypes(props);
    const results = props.results as Record<string, unknown>;
    expect(results.type).toBe('array');
    const items = results.items as Record<string, unknown>;
    expect(items.type).toBe('object');
    const itemProps = items.properties as Record<string, unknown>;
    expect((itemProps.id as Record<string, string>).type).toBe('integer');
  });

  it('should handle undefined gracefully', () => {
    expect(() => fixParamTypes(undefined)).not.toThrow();
  });

  it('should handle empty object', () => {
    expect(() => fixParamTypes({})).not.toThrow();
  });
});

// ─── normalizeToolArgs ─────────────────────────────────────────────────────

describe('normalizeToolArgs', () => {
  it('should return empty object for null/undefined', () => {
    expect(normalizeToolArgs('view_file', null)).toEqual({});
    expect(normalizeToolArgs('view_file', undefined)).toEqual({});
  });

  it('should preserve view_file args', () => {
    expect(normalizeToolArgs('view_file', { file_path: '/test.js' })).toEqual({ file_path: '/test.js' });
    expect(normalizeToolArgs('view_file', { filePath: '/a/b.ts' })).toEqual({ filePath: '/a/b.ts' });
    expect(normalizeToolArgs('view_file', { AbsolutePath: '/x.txt' })).toEqual({ AbsolutePath: '/x.txt' });
  });

  it('should preserve list_dir args', () => {
    expect(normalizeToolArgs('list_dir', { directory: '/src' })).toEqual({ directory: '/src' });
    expect(normalizeToolArgs('list_dir', { dir: '/tmp' })).toEqual({ dir: '/tmp' });
    expect(normalizeToolArgs('list_dir', { DirectoryPath: '/a' })).toEqual({ DirectoryPath: '/a' });
  });

  it('should preserve run_command args', () => {
    const result = normalizeToolArgs('run_command', { cmd: 'ls -la' });
    expect(result).toEqual({ cmd: 'ls -la' });
  });

  it('should preserve run_command.Cwd sub-key', () => {
    const result = normalizeToolArgs('run_command', { CommandLine: 'ls', cwd: '/home' });
    expect(result).toEqual({ CommandLine: 'ls', cwd: '/home' });
  });

  it('should preserve grep_search args', () => {
    const result = normalizeToolArgs('grep_search', { pattern: 'TODO', directory: '/src' });
    expect(result).toEqual({ pattern: 'TODO', directory: '/src' });
  });

  it('should preserve replace_file_content args', () => {
    expect(normalizeToolArgs('replace_file_content', { file: '/a.ts' })).toEqual({ file: '/a.ts' });
    expect(normalizeToolArgs('replace_file_content', { TargetFile: '/b.ts' })).toEqual({ TargetFile: '/b.ts' });
  });

  it('should preserve write_file args', () => {
    expect(normalizeToolArgs('write_file', { path: '/out.ts' })).toEqual({ path: '/out.ts' });
    expect(normalizeToolArgs('write_file', { target: '/out2.ts' })).toEqual({ target: '/out2.ts' });
  });

  it('should preserve search_files args', () => {
    const result = normalizeToolArgs('search_files', { directory: '/src' });
    expect(result).toEqual({ directory: '/src' });
  });

  it('should preserve create_directory args', () => {
    expect(normalizeToolArgs('create_directory', { path: '/new' })).toEqual({ path: '/new' });
  });

  it('should preserve delete_file args', () => {
    expect(normalizeToolArgs('delete_file', { file: '/old.js' })).toEqual({ file: '/old.js' });
  });

  it('should preserve move_file args', () => {
    expect(normalizeToolArgs('move_file', { source: '/a' })).toEqual({ source: '/a' });
    expect(normalizeToolArgs('move_file', { src: '/b' })).toEqual({ src: '/b' });
  });

  it('should preserve unknown tool args without mangling', () => {
    const result = normalizeToolArgs('unknown_tool', { file_path: '/test.txt' });
    expect(result).toEqual({ file_path: '/test.txt' });
  });

  it('should return original args for unknown tool without path-like keys', () => {
    const result = normalizeToolArgs('unknown_tool', { foo: 'bar' });
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should handle array args gracefully', () => {
    const result = normalizeToolArgs('view_file', ['/single.js'] as unknown as Record<string, unknown>);
    expect(result).toEqual(['/single.js']);
  });
});

// ─── translateToolCallToNative ──────────────────────────────────────────────

describe('translateToolCallToNative', () => {
  it('should pass through non-run_command calls', () => {
    const result = translateToolCallToNative('view_file', { AbsolutePath: '/x.ts' });
    expect(result).toEqual({ name: 'view_file', args: { AbsolutePath: '/x.ts' } });
  });

  it('should pass through run_command calls with ls without mangling', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'ls /home/user',
      Cwd: '/tmp',
    });
    expect(result.name).toBe('run_command');
    expect(result.args).toHaveProperty('CommandLine', 'ls /home/user');
  });

  it('should pass through run_command calls with dir without mangling', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'dir src',
      Cwd: 'C:\\project',
    });
    expect(result.name).toBe('run_command');
    expect(result.args).toHaveProperty('CommandLine', 'dir src');
  });

  it('should pass through run_command calls with cat without mangling', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'cat /etc/hosts',
      Cwd: '/',
    });
    expect(result.name).toBe('run_command');
    expect(result.args).toHaveProperty('CommandLine', 'cat /etc/hosts');
  });

  it('should pass through run_command calls with type without mangling', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'type C:\\file.txt',
      Cwd: 'C:\\',
    });
    expect(result.name).toBe('run_command');
  });

  it('should pass through run_command calls with echo redirect', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'echo hello > /tmp/out.txt',
      Cwd: '/',
    });
    expect(result.name).toBe('run_command');
  });

  it('should pass through run_command calls with grep', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'grep -i "TODO" /src',
      Cwd: '/',
    });
    expect(result.name).toBe('run_command');
    expect(result.args).toHaveProperty('CommandLine', 'grep -i "TODO" /src');
  });

  it('should pass through findstr', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'findstr /i TODO *.ts',
      Cwd: 'C:\\src',
    });
    expect(result.name).toBe('run_command');
  });

  it('should pass through unknown commands', () => {
    const result = translateToolCallToNative('run_command', {
      CommandLine: 'npm install',
    });
    expect(result.name).toBe('run_command');
  });
});

// ─── formatTranslatedResponse ───────────────────────────────────────────────

describe('formatTranslatedResponse', () => {
  const info = { originalName: 'run_command', translatedName: 'list_dir', cmd: 'ls' };

  it('should format list_dir array response', () => {
    const result = formatTranslatedResponse(info, [
      { name: 'file.ts', isDir: false, sizeBytes: 100 },
      { name: 'src', isDir: true },
    ]);
    expect(result).toContain('file.ts');
    expect(result).toContain('src');
    expect(result).toContain('<DIR>');
  });

  it('should format list_dir object response with children', () => {
    const result = formatTranslatedResponse(info, {
      children: [{ name: 'a.ts', isDir: false }],
    });
    expect(result).toContain('a.ts');
  });

  it('should format view_file response', () => {
    const viewInfo = { ...info, translatedName: 'view_file' };
    const result = formatTranslatedResponse(viewInfo, { content: 'hello world' });
    expect(result).toBe('hello world');
  });

  it('should format grep_search response', () => {
    const grepInfo = { ...info, translatedName: 'grep_search' };
    const result = formatTranslatedResponse(grepInfo, [{ Filename: 'a.ts', LineNumber: 10, LineContent: 'TODO: fix' }]);
    expect(result).toContain('a.ts:10:TODO: fix');
  });

  it('should format write_file success response', () => {
    const writeInfo = { ...info, translatedName: 'write_file' };
    const result = formatTranslatedResponse(writeInfo, { success: true, path: '/out.ts' });
    expect(result).toContain('File written successfully');
  });

  it('should format write_file failure response', () => {
    const writeInfo = { ...info, translatedName: 'write_file' };
    const result = formatTranslatedResponse(writeInfo, { success: false, error: 'Permission denied' });
    expect(result).toContain('Failed to write file');
  });

  it('should fallback to JSON.stringify for unknown types', () => {
    const result = formatTranslatedResponse(info, 42);
    expect(result).toBe('42');
  });

  it('should fallback to string for string inputs', () => {
    const result = formatTranslatedResponse(info, 'plain text');
    expect(result).toBe('plain text');
  });
});
