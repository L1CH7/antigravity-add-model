import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  detectModelCapabilities,
  detectModelCapabilitiesByName,
} from '../proxy/modelUtils';

describe('detectModelCapabilities', () => {
  it('uses global defaults when model config does not specify limits or flags', () => {
    for (const model of [
      { name: 'claude-3-5-sonnet', provider: 'anthropic' },
      { name: 'deepseek-r1', provider: 'openai', externalModelName: 'deepseek-r1' },
      { name: 'gpt-6.1-sol', provider: 'openai', externalModelName: 'gpt-6.1-sol' },
      { name: 'llama3', provider: 'ollama' },
    ]) {
      const result = detectModelCapabilities(model);
      expect(result.maxTokens).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(result.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      expect(result.supportsImages).toBe(true);
      expect(result.isThinking).toBe(false);
    }
  });

  it('infers thinking from explicit reasoningEfforts config without name guessing', () => {
    const result = detectModelCapabilities({
      name: 'models/custom-sol',
      provider: 'openai',
      reasoningEfforts: ['high', 'max'],
    });
    expect(result.isThinking).toBe(true);
  });

  it('honors explicit limits and capability overrides from model config', () => {
    const result = detectModelCapabilities({
      name: 'models/custom-model',
      provider: 'openai',
      contextWindow: 512_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsThinking: true,
    });
    expect(result.maxTokens).toBe(512_000);
    expect(result.maxOutputTokens).toBe(128_000);
    expect(result.supportsImages).toBe(false);
    expect(result.isThinking).toBe(true);
  });

  it('keeps supportsVision: true when supportsThinking is disabled', () => {
    for (const provider of ['google', 'openai', 'openrouter']) {
      const cap = detectModelCapabilities({
        name: 'models/reasoning-alias',
        provider,
        supportsThinking: false,
      });
      expect(cap.isThinking).toBe(false);
      expect(cap.supportsImages).toBe(true);
    }
  });
});

describe('detectModelCapabilitiesByName', () => {
  it('detects claude thinking models', () => {
    const result = detectModelCapabilitiesByName('claude-3-5-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('detects claude 4 models as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-sonnet-4-20250514');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('detects opus-4 as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-opus-4');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('returns false for non-claude models', () => {
    const result = detectModelCapabilitiesByName('gpt-4o');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles claude-3-7 models', () => {
    const result = detectModelCapabilitiesByName('claude-3-7-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles empty/null input gracefully', () => {
    const result = detectModelCapabilitiesByName('');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });
});
