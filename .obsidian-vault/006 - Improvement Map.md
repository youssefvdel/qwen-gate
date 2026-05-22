# Improvement Map

Organized by impact vs risk.

## Quick Wins (Low Risk, Real Impact)

| # | Change | Files | Why |
|---|---|---|---|
| 1 | **Fix empty catch blocks** — add `console.debug` | `chat.ts:329,556`, `playwright.ts:378` | Suppressed errors hide real problems |
| 2 | **Add `.env.example`** | New file | Every new setup wastes time |
| 3 | **Fix `parseInt(PORT)` NaN** | `index.ts:82` | `PORT=abc` should fallback to 3000 |
| 4 | **Remove file header comments** | All source files | Git blame is better, less noise |
| 5 | **Convert `jsonFix.test.ts` to real assertions** | `tools/jsonFix.test.ts` | Currently a debug script, not a test |

## Medium ROI (Moderate Risk)

| # | Change | Rationale | Risk |
|---|---|---|---|
| 7 | **Consolidate types** (3 files → 1) | Eliminate drift, single source of truth | Medium — touches many imports |
| 8 | **Extract SSE reader** from chat.ts | DRY the streaming/non-streaming parsing | Medium — need clean abstraction |
| 9 | **Add lint config** (Biome or ESLint) | Consistent style, catch bugs early | Low — format-on-save |
| 10 | **Add `.gitattributes`** | Normalize line endings | Low |
| 11 | **Publish test results in CI** | Catch regressions | Medium — needs Playwright in CI |

## Major Changes (High Risk, High Reward)

| # | Change | Rationale | Risk |
|---|---|---|---|
| 12 | **Multi-session support** — different browser profiles for concurrent users | Bypass the single-session Mutex bottleneck | High — needs new session management, multiple Playwright contexts |
| 13 | **Refactor `chatCompletions` into smaller handlers** | Isolate: prompt builder, stream parser, response formatter | High — regression risk, but biggest maintainability win |
| 14 | **Complete or remove runtime engine** | 71 lines of dead code is confusing | Medium — either ship or delete |
| 15 | **Make `/health` check Playwright session validity** | Better monitoring | Low — but risk of false alerts |

## The "Don't Touch" List

| Item | Reason |
|---|---|
| **DI container for global state** | Will add complexity with zero user-facing benefit. The current pattern works. |
| **Remove duplicate `tsx`** | It's correct — needed for Docker `npm ci --omit=dev` |
| **Replace `globalThis._sessionStates`** | Deliberate — survives hot-reloads |
| **Replace custom Mutex with library** | 30 lines, well-understood, no bugs, no dependency needed |
| **Replace `robustParseJSON` with a library** | It's tuned to Qwen's specific output patterns. Library wouldn't handle `{"name":"name":"x"}` |
| **Incremental delta heuristic rewrite** | Works for 90% of cases. Perfect solution would require Qwen to fix its API. |

## The Big Question: What's the Goal?

| If you want... | Do this |
|---|---|
| **Stable proxy for personal use** | #1, #2, #3, #6 — make it work reliably |
| **Multiple concurrent users** | #12 — multi-session is the only way |
| **Production deployment** | #7, #8, #9, #11 — code quality + CI |
| **Learning/portfolio project** | #13, #14 — showcase architecture skills |
| **Just fix usage pain** | Tell me what hurts and I'll adjust |
