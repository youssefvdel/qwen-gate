# v0.7.2 Release — Agentic Tool-Call Emulation for DeepSeek

## Summary

Release focused on making OpenGate a **fully functional agentic coding gateway**: the headline feature is a complete tool-call emulation layer for the free DeepSeek web chat API (`chat.deepseek.com`), which has no native function calling — enabling Hermes-style agents to run multi-turn, **parallel** `tool_calls` coding sessions against DeepSeek. Reasoning is now enabled by default, model metadata is accurate (1M context), and DeepSeek/GLM providers get full request observability. 100 commits since v0.7.1.

> **Note:** This describes the fork's current `main`. An older upstream `v0.7.2` git tag exists on a pre-tool-emulation commit — the version in `package.json` has not been bumped yet; bump to `0.7.2` and add a `[0.7.2]` CHANGELOG section when cutting the real release.

## New Features

### DeepSeek Agentic Tool-Call Emulation (`e05ce8d`)

The core of this release. `chat.deepseek.com`'s `/api/v0/chat/completion` is prompt-based and **silently ignores** a `tools` field — so OpenGate emulates function calling end-to-end:

- **Prompt contract injection** (`toolEmulation.ts`): tool schemas are serialized with a strict JSON-array output contract that is **appended at the very end of the prompt** (recency bias — huge agent system prompts like Hermes's ~23K-token one otherwise bury the contract at position 0 and the model answers in plain text).
- **Parallel tool calls**: the contract asks for a JSON array, and `parseToolCalls()` returns every call the model emits in one turn — Hermes agents issuing multiple simultaneous `tool_calls` (read several files, run searches, etc.) work in both streaming and non-streaming modes.
- **Robust parsing**: handles JSON arrays (parallel), single call objects, JSON code fences, prose-wrapped JSON, and object-form function names; falls back to plain text when the output isn't parseable (heuristic by design).
- **Full multi-turn history** (`pipeline.ts` `messagesToPrompt`): assistant `tool_calls` are echoed back and `role: tool` results are serialized as XML-escaped `<tool_result>` blocks resolved by `tool_call_id`, with a "results already received — do NOT call again" note gating re-invocations. Agentic loops keep complete context across turns.
- **Streaming deltas**: all parallel `tool_calls` are emitted with per-call `index` in streamed `delta.tool_calls` chunks, plus a synthesized `finish_reason: "tool_calls"` chunk.

### Reasoning Enabled by Default

- New `DEEPSEEK_THINKING` config key (default `true`) drives `thinking_enabled` on the web chat request — tool calling works significantly better with reasoning on.
- Non-stream `tool_calls` responses now include `reasoning_content` (previously dropped).

### DeepSeek Web Search

- Declaring a `web_search`-style tool enables DeepSeek's native web search (`search_enabled: true`) — this is how chat.deepseek.com models "search the web" in the web UI.

### Model Catalog + Accurate Metadata

- `/v1/models` now exposes the three real web model types — `deepseek-instant`, `deepseek-expert`, `deepseek-vision` — plus legacy aliases (`deepseek-chat`, `deepseek-reasoner`, `deepseek-vl2`) and common client names (`deepseek-v4-flash`, `deepseek-v4-pro`).
- All entries carry `context_window` / `max_output_tokens` / `modalities` (1M context, 384K max output for text models) so OpenAI clients like Hermes get accurate specs instead of falling back to stale local model databases.
- **Bare model names** work without the `deepseek/` prefix: `deepseek-v4-flash`, `deepseek_chat`, etc.

### Dashboard & Observability

- **DeepSeek pool stats**: `/api/pool/stats` returns a `providers` section (`qwen` + `deepseek`); the Overview page shows a DeepSeek Active / Waiting / Available / Accounts panel with utilization bar.
- **DeepSeek request logging**: client request logging (message count, roles, tools, tool_choice, last message), account telemetry (`totalRequests`, per-model success/error), and `prompt_to_deepseek` persisted in request files.
- **Request-level `.logs` for DeepSeek and GLM**: both providers now write per-request `.logs/*.json` files mirroring the Qwen provider (`c917bdf`).
- **Stream finalize**: streaming requests finalize when the stream completes (not on response headers), so latency/tokens reflect the full stream.

### Reliability & Robustness

- **HTTP-200 JSON error detection**: DeepSeek returns errors like `{"code":40301,"msg":"INVALID_POW_RESPONSE"}` with **HTTP 200** — now detected and surfaced as proper upstream errors (408/401/429/400) so the handler retries with a fresh PoW instead of silently returning an empty response.
- **Single-use PoW**: removed the per-(email, target_path) PoW cache — each solution is accepted exactly once; a fresh Proof-of-Work is solved per request.
- **Synthetic finish chunk**: if the upstream stream ends without a `finish_reason` (common with DeepSeek's FINISHED status patch), OpenGate emits an OpenAI `finish_reason: "stop"` chunk before `[DONE]` so clients don't treat the stream as truncated.
- **Patch SSE chunks in streaming**: SSE chunks are now emitted for patch operations — fixes missing content in DeepSeek streams (`66c8348`).

### Model Router & Qwen

- Dot-format aliases for all model fallback chains, plus a dash-format alias and fallback chain for `qwen3.8-max-preview` (`de94ce1`, `297b31c`, `7554950`).
- Upstream **429s skip HTTP-level retry** so model fallback kicks in faster (`05ebb83`).
- Streaming loop detection + `pendingCorrections` to break runaway tool loops (`e7f9dfe`); tool-loop correction prompts persist across account rotation and inline tool results (`ac21ef1`).
- Restored `context.txt` auto-upload for large Qwen contexts + anti-hallucination grounding rules (`4973ae2`); clarified that `context.txt` is an upload artifact, not a local file — models no longer try local-file tools on it (`994fc14`).

### GLM

- Fresh chat session per request — no 30-min cached reuse; full conversation stays in `messages` (`755fd06`).
- Message content arrays (OpenAI format) handled in DeepSeek and GLM prompts (`796ec29`).

## Bug Fixes

- DeepSeek stream errors no longer crash the process — non-Error rejection values (client disconnects) are handled as clean aborts
- DeepSeek THINK fragment type + `response/fragments` append / SET content ops parsing fixed (`675705c`, `f9021a1`, `3ac5784`)
- GLM no longer auto-opens a headed browser at startup — Login button only (`39e679c`)
- System messages correctly included as `<system>` tags in DeepSeek/GLM prompts (`a6b2f7e`, `ef146e8`)
- Biome import-sort + formatting fixes in pre-existing files so the CI `biome check` gate passes (`3e4b1fb`, `03d0061`)

## Performance & Reliability

- Fresh PoW per request eliminates the `40301 INVALID_POW_RESPONSE` reuse failures
- Accurate prompt-token estimation (chars-per-token heuristic) for client context gauges
- Stream finalize timing reflects true stream duration

## Code Quality

- 157 tests passing; `biome check` + `tsc --noEmit` green on CI
- Docs updated: CHANGELOG, README, API reference, DEVELOPMENT, ARCHITECTURE, DEPLOYMENT, DeepSeek reverse-engineering docs

## Verified Live

- Parallel tool calls (non-stream + stream) against real DeepSeek accounts
- Multi-turn Hermes agent sessions (file reading, searching, edits) with full tool history
- 24-turn sustained profile with 0 errors
- `reasoning_content` flowing alongside tool calls

## Breaking Changes / Notes

- DeepSeek `DEEPSEEK_THINKING` defaults to `true` — reasoning is now on for DeepSeek requests unless disabled (`DEEPSEEK_THINKING=false`)
- DeepSeek PoW solutions are single-use; the old per-account cache is gone
- `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro` are the canonical client-facing names (renamed from earlier aliases)
