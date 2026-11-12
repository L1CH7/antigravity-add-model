import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

// We need to mock the external dependencies that proxy.ts imports at module level
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/mock/home';
      return '/mock/' + name;
    }),
    getAppPath: vi.fn(() => '/mock/app'),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../cryptoStore', () => ({
  encryptModels: vi.fn((m: unknown) => m),
  decryptModels: vi.fn((m: unknown) => m),
  encryptString: vi.fn((s: string) => s),
  decryptString: vi.fn((s: string) => s),
  backupFile: vi.fn(),
}));

// ─── Test: generateModelPlaceholderId (via concept) ────────────────────────

function generateModelPlaceholderId(model: { displayName?: string; name?: string }): string {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash; // Force 32-bit integer
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

// ─── Test: toSlug (via concept) ───────────────────────────────────────────

function toSlug(model: { externalModelName?: string; name?: string }): string {
  return (
    'custom-' +
    (model.externalModelName || model.name || '')
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

// ─── Test: parseRetryAfter (via concept) ──────────────────────────────────

function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
  const val = headers['retry-after'];
  if (!val) return 0;

  const raw = Array.isArray(val) ? val[0] : val;
  if (!raw) return 0;

  const seconds = parseInt(raw.trim(), 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('generateModelPlaceholderId', () => {
  it('generates deterministic IDs for the same input', () => {
    const id1 = generateModelPlaceholderId({ name: 'gpt-4o', displayName: 'GPT-4o' });
    const id2 = generateModelPlaceholderId({ name: 'gpt-4o', displayName: 'GPT-4o' });
    expect(id1).toBe(id2);
  });

  it('produces IDs in the MODEL_PLACEHOLDER_M format', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id).toMatch(/^MODEL_PLACEHOLDER_M\d+$/);
  });

  it('produces different IDs for different models', () => {
    const id1 = generateModelPlaceholderId({ name: 'gpt-4o' });
    const id2 = generateModelPlaceholderId({ name: 'claude-3-5-sonnet' });
    expect(id1).not.toBe(id2);
  });

  it('uses displayName over name', () => {
    const id1 = generateModelPlaceholderId({ name: 'models/gpt-4o', displayName: 'My GPT-4o' });
    const id2 = generateModelPlaceholderId({ name: 'models/gpt-4o', displayName: 'Different Name' });
    expect(id1).not.toBe(id2);
  });

  it('falls back to name when displayName is missing', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id).toBeTruthy();
  });

  it('falls back to "custom-model" when both name and displayName missing', () => {
    const id = generateModelPlaceholderId({});
    expect(id).toBeTruthy();
  });

  it('placeholder number is within range [400, 599]', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    const num = parseInt(id.replace('MODEL_PLACEHOLDER_M', ''), 10);
    expect(num).toBeGreaterThanOrEqual(400);
    expect(num).toBeLessThanOrEqual(599);
  });

  it('lowercases the input before hashing', () => {
    const id1 = generateModelPlaceholderId({ name: 'GPT-4O' });
    const id2 = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id1).toBe(id2);
  });
});

describe('toSlug', () => {
  it('prefixes with "custom-"', () => {
    const slug = toSlug({ name: 'gpt-4o' });
    expect(slug).toMatch(/^custom-/);
  });

  it('removes "models/" prefix from externalModelName', () => {
    const slug = toSlug({ externalModelName: 'models/gpt-4o' });
    expect(slug).toBe('custom-gpt-4o');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    const slug = toSlug({ name: 'GPT 4o (Latest)' });
    expect(slug).toBe('custom-gpt-4o-latest');
  });

  it('removes leading and trailing hyphens', () => {
    const slug = toSlug({ name: '--test--' });
    expect(slug).toBe('custom-test');
  });

  it('lowercases the result', () => {
    const slug = toSlug({ name: 'GPT-4O' });
    expect(slug).toBe('custom-gpt-4o');
  });

  it('uses externalModelName over name', () => {
    const slug = toSlug({ name: 'gpt-4o', externalModelName: 'openai/gpt-4o' });
    expect(slug).toBe('custom-openai-gpt-4o');
  });

  it('handles OpenRouter model format (provider/model)', () => {
    const slug = toSlug({ externalModelName: 'openai/gpt-4o' });
    expect(slug).toBe('custom-openai-gpt-4o');
  });
});

describe('parseRetryAfter', () => {
  it('returns 0 when no Retry-After header', () => {
    expect(parseRetryAfter({})).toBe(0);
  });

  it('parses delta-seconds format (integer)', () => {
    expect(parseRetryAfter({ 'retry-after': '120' })).toBe(120_000);
  });

  it('parses delta-seconds with whitespace', () => {
    expect(parseRetryAfter({ 'retry-after': '  60  ' })).toBe(60_000);
  });

  it('returns 0 for negative delta-seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '-5' })).toBe(0);
  });

  it('parses HTTP-date format for future date', () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter({ 'retry-after': futureDate });
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(61_000); // allow 1s tolerance
  });

  it('returns 0 for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter({ 'retry-after': pastDate })).toBe(0);
  });

  it('handles array value (takes first element)', () => {
    expect(parseRetryAfter({ 'retry-after': ['30', '60'] })).toBe(30_000);
  });

  it('returns 0 for invalid string', () => {
    expect(parseRetryAfter({ 'retry-after': 'not-a-number' })).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseRetryAfter({ 'retry-after': '' })).toBe(0);
  });
});

import {
  generateModelPlaceholderId as realGenerateModelPlaceholderId,
  collectOccupiedPlaceholders,
  resolveCustomModelKeys,
  mergeFetchAvailableModelsResponse,
  mergeListModelsResponse,
  findMatchedCustomModel,
  type CustomModel,
} from '../proxy';
import { validateCustomModel } from '../schemaValidator';

describe('real proxy model registration and native model protection', () => {
  const makeModel = (overrides: Partial<CustomModel>): CustomModel => ({
    name: 'models/custom-x',
    displayName: 'Custom X',
    description: '',
    provider: 'openai',
    apiKey: 'test-key',
    apiUrl: 'http://127.0.0.1:8045/v1/chat/completions',
    externalModelName: 'gemini-3.8-flash-low',
    ...overrides,
  });

  it('generates valid enum placeholder IDs in preferred upper range [1000..1650]', () => {
    const id = realGenerateModelPlaceholderId(makeModel({}));
    const num = parseInt(id.replace('MODEL_PLACEHOLDER_M', ''), 10);
    expect(num).toBeGreaterThanOrEqual(1000);
    expect(num).toBeLessThanOrEqual(1650);
  });

  it('collects all occupied MODEL_PLACEHOLDER_M* IDs from Google responses', () => {
    const occupied = collectOccupiedPlaceholders({
      defaultAgentModelId: 'MODEL_PLACEHOLDER_M7',
      availableModels: {
        'models/gemini-4-argon-medium': { model: 'MODEL_PLACEHOLDER_M528' },
        'models/gemini-3.8-flash-low': { model: 'MODEL_PLACEHOLDER_M26' },
      },
      deprecatedModelIds: {
        'MODEL_PLACEHOLDER_M381': { newModelId: 'MODEL_PLACEHOLDER_M528' },
      },
      tieredModelIds: ['MODEL_PLACEHOLDER_M427'],
    });
    expect(occupied.has('MODEL_PLACEHOLDER_M7')).toBe(true);
    expect(occupied.has('MODEL_PLACEHOLDER_M528')).toBe(true);
    expect(occupied.has('MODEL_PLACEHOLDER_M26')).toBe(true);
    expect(occupied.has('MODEL_PLACEHOLDER_M381')).toBe(true);
    expect(occupied.has('MODEL_PLACEHOLDER_M427')).toBe(true);
  });

  it('avoids collisions with Google-occupied placeholders and falls back into [0..999] when upper range is full', () => {
    const m = makeModel({ displayName: 'GPT-6.1 Sol Max', externalModelName: 'gpt-6.1-sol-max' });
    const baseId = realGenerateModelPlaceholderId(m);

    const occupiedSame = new Set<string>([baseId]);
    const shifted = resolveCustomModelKeys([m], occupiedSame);
    expect(shifted[0].placeholderId).not.toBe(baseId);
    const shiftedNum = parseInt(shifted[0].placeholderId.replace('MODEL_PLACEHOLDER_M', ''), 10);
    expect(shiftedNum).toBeGreaterThanOrEqual(0);
    expect(shiftedNum).toBeLessThanOrEqual(1650);

    // Fill the entire preferred [1000..1650] range plus M999 so fallback selects M998.
    const allPreferredPlus999 = new Set<string>();
    for (let n = 1000; n <= 1650; n++) allPreferredPlus999.add(`MODEL_PLACEHOLDER_M${n}`);
    allPreferredPlus999.add('MODEL_PLACEHOLDER_M999');
    const fallback = resolveCustomModelKeys([m], allPreferredPlus999);
    expect(fallback[0].placeholderId).toBe('MODEL_PLACEHOLDER_M998');
  });

  it('assigns unique slugs and placeholder IDs when externalModelName collides', () => {
    const m1 = makeModel({ displayName: 'Argon (Native)', provider: 'google', externalModelName: 'gemini-4-argon' });
    const m2 = makeModel({ displayName: 'Argon (OpenAI)', provider: 'openai', externalModelName: 'gemini-4-argon' });
    const resolved = resolveCustomModelKeys([m1, m2]);
    expect(resolved[0].slug).toBe('custom-gemini-4-argon');
    expect(resolved[1].slug).toBe('custom-gemini-4-argon-openai');
    expect(resolved[0].placeholderId).not.toBe(resolved[1].placeholderId);
  });

  it('keeps native Google models intact, skips Google placeholders, and appends agentModelSorts', () => {
    const m = makeModel({
      name: 'models/gemini-3.8-flash-low',
      displayName: 'Custom Flash (Low)',
      externalModelName: 'gemini-3.8-flash-low',
      supportsVision: true,
      supportsThinking: false,
    });
    const basePlaceholder = realGenerateModelPlaceholderId(m);
    const googleResponse = {
      availableModels: {
        'models/gemini-3.8-flash-low': {
          displayName: 'Gemini 3.8 Flash (Low)',
          model: 'MODEL_PLACEHOLDER_M26',
          maxTokens: 1048576,
        },
        'models/gemini-4-argon-medium': {
          displayName: 'Gemini 4 Argon (Medium)',
          model: basePlaceholder,
          maxTokens: 1048576,
        },
      },
      agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['models/gemini-3.8-flash-low', 'models/gemini-4-argon-medium'] }] }],
    };
    const merged = mergeFetchAvailableModelsResponse(googleResponse, [m]) as any;
    expect(merged.availableModels['models/gemini-3.8-flash-low']).toEqual({
      displayName: 'Gemini 3.8 Flash (Low)',
      model: 'MODEL_PLACEHOLDER_M26',
      maxTokens: 1048576,
    });
    expect(merged.availableModels['custom-gemini-3-8-flash-low']).toMatchObject({
      displayName: 'Custom Flash (Low)',
      supportsImages: true,
      supportsThinking: false,
    });
    // Кастомная модель обязана получить свободный enum и не пересекаться с Google basePlaceholder.
    const assigned = merged.availableModels['custom-gemini-3-8-flash-low'].model as string;
    expect(assigned).not.toBe(basePlaceholder);
    expect(assigned).not.toBe('MODEL_PLACEHOLDER_M26');
    const assignedNum = parseInt(assigned.replace('MODEL_PLACEHOLDER_M', ''), 10);
    expect(assignedNum).toBeGreaterThanOrEqual(0);
    expect(assignedNum).toBeLessThanOrEqual(1650);
    expect(findMatchedCustomModel([m], assigned)?.displayName).toBe('Custom Flash (Low)');
    expect(merged.agentModelSorts[0].groups[0].modelIds).toEqual([
      'models/gemini-3.8-flash-low',
      'models/gemini-4-argon-medium',
      'custom-gemini-3-8-flash-low',
    ]);
  });

  it('keeps /v1beta/models as an array and appends custom models after native ones', () => {
    const googleList = {
      models: [{ name: 'models/gemini-3.8-flash-low', displayName: 'Official Google' }],
    };
    const m = makeModel({ displayName: 'Custom Model', externalModelName: 'my-ext' });
    const merged = mergeListModelsResponse(googleList, [m]) as { models: Array<{ name: string }> };
    expect(Array.isArray(merged.models)).toBe(true);
    expect(merged.models[0]).toEqual({ name: 'models/gemini-3.8-flash-low', displayName: 'Official Google' });
    expect(merged.models[1].name).toMatch(/^models\/MODEL_PLACEHOLDER_M\d{1,4}$/);
  });

  it('never intercepts native Google model calls even if a custom model shares its name', () => {
    const m = makeModel({
      name: 'models/gemini-3.8-flash-low',
      displayName: 'Custom Flash',
      externalModelName: 'gemini-3.8-flash-low',
    });
    const resolved = resolveCustomModelKeys([m]);
    expect(findMatchedCustomModel([m], 'models/gemini-3.8-flash-low')).toBeUndefined();
    expect(findMatchedCustomModel([m], resolved[0].slug)?.displayName).toBe('Custom Flash');
    expect(findMatchedCustomModel([m], resolved[0].placeholderId)?.displayName).toBe('Custom Flash');
  });
});

describe('schemaValidator with reasoningEfforts and max', () => {
  it('accepts max as reasoningEffort', () => {
    const res = validateCustomModel({
      name: 'models/deepseek-test',
      provider: 'openai',
      apiUrl: 'https://example.com/v1',
      reasoningEffort: 'max',
    });
    expect(res.valid).toBe(true);
  });

  it('accepts valid reasoningEfforts array', () => {
    const res = validateCustomModel({
      name: 'models/deepseek-test',
      provider: 'openai',
      apiUrl: 'https://example.com/v1',
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
    });
    expect(res.valid).toBe(true);
  });

  it('rejects invalid effort in reasoningEfforts array', () => {
    const res = validateCustomModel({
      name: 'models/deepseek-test',
      provider: 'openai',
      apiUrl: 'https://example.com/v1',
      reasoningEfforts: ['low', 'super_mega_ultra'],
    });
    expect(res.valid).toBe(false);
  });
});
