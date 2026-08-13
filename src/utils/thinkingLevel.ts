/**
 * Thinking / reasoning level resolution.
 *
 * qwengate supports three levels that map directly onto Qwen's
 * `feature_config.thinking_format`:
 *
 *   off     → thinking disabled (thinking_enabled=false)
 *   summary → compact thinking summary (thinking_format="summary")
 *   full    → deep reasoning trace (thinking_format="full")
 *
 * Levels are picked from (in priority order):
 *   1. A `-no-thinking` model suffix
 *   2. The THINKING_MODE config override (off | summary | full)
 *   3. The client's intent — Claude Code `thinking` block (budget_tokens)
 *      or OpenAI `reasoning_effort`
 *   4. Default: summary (matches qwen-gate's historical always-on thinking)
 */

export type ThinkingLevel = 'off' | 'summary' | 'full';
export type ThinkingFormat = 'summary' | 'full';

export interface ThinkingRequestIntent {
  type?: string;
  enabled?: boolean;
  budget_tokens?: number;
  budgetTokens?: number;
}

/**
 * Claude Code thinking tiers map to budget_tokens roughly as:
 *   low    → 3_328
 *   medium → 6_656
 *   high   → 13_312
 * Anything above the mid-point is treated as deep/full thinking.
 */
const FULL_THINKING_BUDGET_THRESHOLD = 8_000;

export function levelForBudget(budget: number | undefined): ThinkingLevel {
  if (!budget || budget <= 0) return 'summary';
  return budget >= FULL_THINKING_BUDGET_THRESHOLD ? 'full' : 'summary';
}

export function resolveThinkingLevel(opts: {
  mode: string;
  model: string;
  intent?: ThinkingRequestIntent;
  reasoningEffort?: string;
}): ThinkingLevel {
  if (opts.model.includes('-no-thinking')) return 'off';

  const mode = (opts.mode || 'auto').toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'summary') return 'summary';
  if (mode === 'full') return 'full';

  const intent = opts.intent;
  if (intent) {
    const disabled = intent.type === 'disabled' || intent.enabled === false;
    if (disabled) return 'off';
    if (intent.type === 'enabled' || intent.enabled === true) {
      return levelForBudget(intent.budget_tokens ?? intent.budgetTokens);
    }
  }

  const effort = (opts.reasoningEffort || '').toLowerCase();
  if (effort === 'off' || effort === 'none') return 'off';
  if (effort === 'full' || effort === 'deep' || effort === 'high') return 'full';
  if (effort === 'summary') return 'summary';
  if (effort === 'low' || effort === 'medium') return 'summary';

  return 'summary';
}
