# Taking Stock: What We Know

## The Project is Actually Impressive

This isn't another "wrapper around an API." It's a **reverse engineering effort** that:

1. Decoded Qwen's internal API protocol (SSE format, auth system, model list, settings)
2. Solved the anti-bot header problem with Playwright route interception
3. Built a working OpenAI-compatible streaming interface on top
4. Added a tool/function calling system via prompt engineering (no native support exists)
5. Handles real LLM output pathology (malformed JSON, inconsistent streaming modes)
6. Survives hot-reloads (globalThis pattern is deliberate)
7. Works in Docker

## The Code Quality is Uneven — And That Makes Sense

The **tool system** (registry, schema, parser, executor) is clean, well-typed, well-documented. This was built with care.

The **chat handler** is a 654-line god function. This was built under pressure — make it work first, make it pretty later.

The **types** are duplicated. This is a refactoring debt that accumulated as the project grew.

The **runtime engine** is half-built. It was the *next* architecture that never got finished.

## The Real Bottleneck is Upstream

No amount of refactoring the proxy will fix:
- Qwen's single-session limit (Mutex is a workaround, not a solution)
- Qwen's inconsistent streaming (delta heuristic is the best we can do)
- Qwen's anti-bot headers (browser interception is the only way)

## The Leverage Points

If we want to make this **actually better** (not just different), the changes with real impact are:

| Change | Impact |
|---|---|
| Multi-session support | Break the Mutex bottleneck → true concurrency |
| Fix send button selectors | Reliable header extraction → faster refresh |
| Observability (logs + metrics) | Know what breaks → fix the right things |
| Complete the runtime engine | State machine would make concurrent sessions manageable |

Everything else (types, linting, comments) is polish — nice to have, but won't change how the proxy works.
