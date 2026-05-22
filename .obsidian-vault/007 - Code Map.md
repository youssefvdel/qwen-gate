# Code Map — File-by-File Anatomy

## `src/index.ts` (106 lines) — Entry Point

```
imports → dotenv → create Hono app → CORS → API key middleware →
  /health route → POST /v1/chat/completions → GET /v1/models →
  if (main) parse --browser flag → initPlaywright → serve
```

Key details:
- CORS is wide open: `app.use('*', cors())`
- API key is optional (no key = no auth)
- Browser type from CLI arg > env var > default chromium
- `process.exit(1)` on Playwright init failure (non-resilient)
- Port: `parseInt(process.env.PORT)` — NaN if PORT is non-numeric

## `src/routes/chat.ts` (654 lines) — The God Function

Largest file. Handles:

| Lines | Section | What |
|---|---|---|
| 36-67 | `getIncrementalDelta()` | Streaming diff algorithm |
| 69-93 | `parseQwenErrorPayload()` | Detect upstream error in buffer |
| 95-381 | `chatCompletions()` | Non-streaming path |
| 387-648 | `chatCompletions()` | Streaming path (continuation) |

The streaming and non-streaming paths share this structure:
1. Build prompt from messages (lines 100-184)
2. Inject tool definitions (lines 161-182)
3. Acquire mutex (line 196)
4. Retry loop for Qwen API call (lines 200-229)
5. SSE parsing loop (duplicated!)
6. Tool call extraction
7. Response formatting

## `src/services/playwright.ts` (467 lines) — Browser Automation

| Lines | Function | What |
|---|---|---|
| 26-50 | `Mutex` class | Simple promise-based lock |
| 73-137 | `initPlaywright()` | Launch browser, check session, auto-login |
| 139-151 | `checkValidSession()` | Verify auth cookies exist and work |
| 153-174 | `attemptAutoLogin()` | Try API login → UI fallback |
| 185-229 | `loginToQwen()` | API-based login with SHA256 password |
| 231-271 | `loginToQwenUI()` | UI-based login (fill form, submit) |
| 276-285 | `getQwenHeaders()` | Public method with mutex |
| 287-467 | `_getQwenHeadersInternal()` | Core: navigate → intercept → extract → abort |

## `src/services/qwen.ts` (335 lines) — Qwen API Integration

| Lines | Function | What |
|---|---|---|
| 11-31 | Error classes | `RetryableQwenStreamError`, `QwenUpstreamError` |
| 33-34 | `sessionStates` | GlobalThis state for parent message tracking |
| 88-142 | `disableNativeTools()` | API call to turn off Qwen built-in tools |
| 144-194 | `fetchQwenModels()` | Model list with 1h cache + `-no-thinking` variants |
| 196-335 | `createQwenStream()` | Main: build payload, call API, return stream |

Creates the Qwen-specific payload with `fid`, `feature_config`, `chat_type: 't2t'`, etc.

## `src/tools/` — Tool System (4 files, ~713 lines total)

| File | Lines | Purpose |
|---|---|---|
| `types.ts` | 104 | `JsonSchema`, `ToolRegistration`, `ToolHandler`, etc. |
| `registry.ts` | 142 | Tool map with register/lookup/execute |
| `schema.ts` | 285 | JSON Schema validator (hand-written) |
| `executor.ts` | 236 | Agentic loop: call LLM → parse → execute → repeat |
| `parser.ts` | 150 | Streaming `<tool_call>` tag parser |

Quality: These are the cleanest files in the project. Well-documented, good error handling, clean separation.

## `src/types/openai.ts` (188 lines) — OpenAI Types

Complete type definitions for the OpenAI API surface:
- `JsonSchema`, `FunctionToolDefinition`
- `Message`, `OpenAIRequest`
- `ChoiceDelta`, `ChatCompletionChunk`, `Usage`
- `ToolHandler`, `ToolRegistration`, `ToolPolicy`
- Tool policy (`maxCallsPerRun`, `requiresApproval`, `rateLimit`, `allowedContexts`)

## `src/utils/json.ts` (198 lines) — Robust JSON Parser

`robustParseJSON(str)`: 7-stage JSON repair pipeline:
1. Strip markdown code blocks
2. Fix unquoted property names
3. Fix double key hallucinations
4. Clean trailing noise
5. Escape control characters in strings
6. Count and close unmatched braces/brackets
7. Aggressive fallback with trailing comma fix

## `src/utils/types.ts` (101 lines) — Duplicated Types

Re-exports from `tools/types.ts` plus redefines:
- `ToolChoice`, `Message`, `OpenAIRequest`
- `ChoiceDelta`, `ChatCompletionChunk`, `Usage`

These overlap significantly with `types/openai.ts` and `tools/types.ts`.

## `src/runtime/` — Half-Built State Machine (~236 lines total)

| File | Lines | What |
|---|---|---|
| `types.ts` | 165 | Complete state machine types: `AgentPhase`, `AgentState`, `AgentEvent`, `LLMAdapter` |
| `engine.ts` | 71 | Only has `createInitialState()` and constants — dead code |

The types are actually well-designed: phases (idle→planning→calling_llm→parsing→executing→streaming→completed/error), events with timestamps, adapters for LLM. But the engine never got built.

## Tests (7 files, ~1204 lines)

| File | Lines | Type | Quality |
|---|---|---|---|
| `index.test.ts` | 319 | Integration (mocked) | Good — covers routes, auth, models, streaming, non-streaming, rate limiting |
| `advanced.test.ts` | 229 | Integration (mocked) | Good — reasoning history, whitespace preservation, session tracking |
| `agenticStress.test.ts` | 360 | E2E (real Qwen) | Comprehensive — 8-turn tool calling conversation with real browser |
| `concurrentChat.test.ts` | 73 | Integration (real browser) | Tests mutex prevents concurrent request failure |
| `parser.test.ts` | 89 | Unit | Good — 6 test cases covering edge cases |
| `delta.test.ts` | 63 | Unit | Good — cumulative, incremental, repetitive word edge case |
| `jsonFix.test.ts` | 98 | Debug script (not test) | Uses console.log, no assertions |
| `parallel.test.ts` | 42 | Unit | Tests `Promise.all` parallelism |
