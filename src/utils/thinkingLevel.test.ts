import { describe, expect, test } from 'bun:test';
import { levelForBudget, resolveThinkingLevel } from './thinkingLevel.ts';

describe('resolveThinkingLevel', () => {
  test('Claude Code thinking=disabled → off', () => {
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max', intent: { type: 'disabled' } })).toBe('off');
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max', intent: { enabled: false } })).toBe('off');
  });

  test('Claude Code budget_tokens maps to summary/full', () => {
    expect(levelForBudget(3328)).toBe('summary'); // low
    expect(levelForBudget(6656)).toBe('summary'); // medium
    expect(levelForBudget(13312)).toBe('full'); // high
  });

  test('-no-thinking model suffix wins', () => {
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max-no-thinking' })).toBe('off');
  });

  test('THINKING_MODE config override', () => {
    expect(resolveThinkingLevel({ mode: 'off', model: 'qwen3.7-max' })).toBe('off');
    expect(resolveThinkingLevel({ mode: 'summary', model: 'qwen3.7-max' })).toBe('summary');
    expect(resolveThinkingLevel({ mode: 'full', model: 'qwen3.7-max' })).toBe('full');
    // explicit config beats client intent
    expect(resolveThinkingLevel({ mode: 'off', model: 'qwen3.7-max', intent: { type: 'enabled', budget_tokens: 20000 } })).toBe('off');
  });

  test('OpenAI reasoning_effort', () => {
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max', reasoningEffort: 'high' })).toBe('full');
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max', reasoningEffort: 'medium' })).toBe('summary');
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max', reasoningEffort: 'off' })).toBe('off');
  });

  test('default stays summary (matches qwen-gate always-on thinking)', () => {
    expect(resolveThinkingLevel({ mode: 'auto', model: 'qwen3.7-max' })).toBe('summary');
  });
});
