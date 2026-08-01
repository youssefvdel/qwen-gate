# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **DeepSeek Agentic Tool-Call Emulation**: `chat.deepseek.com`'s web API has no native function calling — tool calling is now emulated by injecting the tool schemas with a strict JSON-array output contract at the **end** of the prompt, then parsing the model's text output into structured `tool_calls`. Supports **parallel tool calls** (Hermes-style agents issuing multiple simultaneous calls), full multi-turn tool history serialization (assistant `tool_calls` echoed + XML-escaped `<tool_result>` blocks resolved by `tool_call_id`, with a results-follow gated "do NOT call again" note), and `search_enabled` wiring when a `web_search` tool is declared. (#deepseek, toolEmulation.ts/pipeline.ts)
- **DeepSeek Reasoning By Default**: New `DEEPSEEK_THINKING` config key (default `true`) drives `thinking_enabled` on the web chat request. Non-stream `tool_calls` responses now include `reasoning_content` (previously dropped). (#deepseek, configService.ts/pipeline.ts)
- **DeepSeek HTTP-200 JSON Error Detection**: DeepSeek returns errors like `{"code":40301,"msg":"INVALID_POW_RESPONSE"}` with **HTTP 200** — these are now detected and surfaced as retryable upstream errors instead of silently becoming empty responses. (#deepseek, pipeline.ts)
- **DeepSeek Model Catalog + Context Specs**: `/v1/models` now exposes the three real web model types (`deepseek-instant`, `deepseek-expert`, `deepseek-vision`) plus legacy aliases (`deepseek-chat`/`deepseek-reasoner`/`deepseek-vl2`) and common client names (`deepseek-v4-flash`/`deepseek-v4-pro`). Entries carry `context_window` / `max_output_tokens` / `modalities` (1M context, 384K max output for text models) so OpenAI clients get accurate metadata. (#api, providerModels.ts/index.tsx)
- **Bare DeepSeek Model Names**: `deepseek-*` and `deepseek_*` model names (no `deepseek/` prefix) now route to the DeepSeek provider. (#routing, providerRegistry.ts)
- **DeepSeek Pool Stats on Dashboard**: `/api/pool/stats` returns a `providers` section (`qwen` + `deepseek`); the Overview page shows a DeepSeek Active / Waiting / Available / Accounts panel with utilization bar. (#dashboard, dashboardRoutes.ts/overview.ts/overview.css/overview.js)
- **DeepSeek Request Observability**: Client request logging (message count, roles, tools, tool_choice, last message), account telemetry (`totalRequests`, per-model success/error), `prompt_to_deepseek` persisted in request files, and stream finalize with real tokens/latency/content. (#deepseek, handler.ts/logStore.ts)
- **Request-Level `.logs` for DeepSeek and GLM**: Both providers now write per-request `.logs/*.json` files mirroring the Qwen provider. (#logging, deepseek/handler.ts+glm/handler.ts+pipeline.ts)
- **Model-Router Aliases**: Dot-format aliases for all model fallback chains, plus a dash-format alias and fallback chain for `qwen3.8-max-preview`. (#routing, modelRouter.ts)
- **GLM Fresh Session Per Request**: GLM chat sessions are now created per request instead of 30-min cached reuse — the full conversation stays in `messages`. (#glm, session.ts)

### Changed
- **DeepSeek PoW Solutions Are Single-Use**: Removed the per-(email, target_path) PoW response cache. Each solution is accepted exactly once — a fresh PoW is solved per request and retried on `40301 INVALID_POW_RESPONSE`. (#deepseek, pow.ts)
- **DeepSeek Stream Finalize**: Streaming requests now finalize when the stream completes (not on response headers) so latency/tokens reflect the full stream; a synthetic OpenAI `finish_reason` chunk is emitted if upstream ends without one. (#deepseek, pipeline.ts/handler.ts)

### Fixed
- **Restore `context.txt` upload**: Large-context auto-upload to `context.txt` restored; anti-hallucination grounding rules added to the system prompt. (#qwen, session.ts/defaultSystemPrompt.ts/modelRouter.ts/qwenFileUpload.ts)
- **`context.txt` clarified as non-local**: Models no longer attempt local-file tools on `context.txt`. (#qwen, defaultSystemPrompt.ts)
- **Upstream 429 skips HTTP-level retry**: 429 errors skip HTTP retry so model fallback kicks in faster. (#retry, retry.ts)
- **Streaming loop detection**: Loop detection + `pendingCorrections` added to the Qwen streaming pipeline. (#qwen, pipeline-stream.ts/defaultSystemPrompt.ts)
- **Tool-loop corrections persist**: Correction prompts now survive account rotation and inline tool results. (#qwen, pipeline-nonstream.ts/session.ts)
- **DeepSeek patch SSE chunks**: SSE chunks are now emitted for patch operations in streaming mode — fixes missing content in stream. (#deepseek, stream.ts)
- **Message content arrays**: OpenAI-format message content arrays handled in DeepSeek and GLM prompts. (#deepseek/#glm, pipeline.ts)

### Changed
- **GLM x-signature removed**: Confirmed `x-signature` header is NOT required by GLM API. Removed broken HMAC-SHA256 computation from `spoofing.ts`. The real gate is Aliyun Captcha (`FRONTEND_CAPTCHA_REQUIRED`), which is session-bound and requires browser context. (#glm, spoofing.ts)
- **Account rotation for per-provider picking**: `isAvailable()` now checks the specific provider's token, not just Qwen. New `pickAccountForProvider(provider, excludeEmail?)` function. (#auth, accountManager.ts)
- **GLM handler rewrite**: Added 5x retry loop with account rotation, error classification (rate limit, bot detection, auth failure, timeout), and proper error responses. (#glm, handler.ts)

### Added
- **DeepSeek Browserless Rewrite**: Full rewrite of PoW solver (`pow.ts`) — uses real DeepSeek WebAssembly (`sha3_wasm_bg.wasm`, custom LE Keccak-256) directly in Node.js, no browser needed. New `leim.ts` fetches hif-leim WAF bypass token (10-min cache). Session creation (`session.ts`) fixed to use `/api/v0/chat/completion` PoW target (server rejects other targets). Pipeline (`pipeline.ts`) uses wreqFetch TLS impersonation with full browser headers + PoW + leim. Handler (`handler.ts`) adds 5x retry loop with account rotation and error classification (rate limit, bot detection, auth failure, timeout). Verified working end-to-end from Node.js with WASM PoW solve (~30ms). (#deepseek, pow.ts/leim.ts/session.ts/pipeline.ts/handler.ts/spoofing.ts)

### Added
- **Bot Detection Status via `lastError`**: `ProviderAuthState.lastError?: string` field; `setProviderStateLastError()` helper; `getAuthStatus()` checks `/captcha|bot|waf/i` first and returns `'captcha'`; `getAccountStats()` exposes `lastError` per provider. Dashboard renders "Bot Detect" badge. (#auth, types/auth.ts/accountManager.ts)
- **Auto-Login Sets `lastError`**: `/api/accounts/:email/auto-login/{deepseek,glm}` endpoints set `lastError` on captcha/error, clear it on success. (#auth, dashboardRoutes.ts)
- **Scoped Provider Removal**: `removeProviderFromAccount(email, provider)` removes one provider; calls `removeAccount()` (deletes email + password + browser profile) if no providers remain. (#accounts, accountManager.ts)
- **DELETE `/api/accounts/:email/provider/:provider`**: New endpoint for provider-scoped removal. Returns `{ok, accountDeleted}`. (#api, dashboardRoutes.ts)

### Added
- **DeepSeek Spoofing Module**: New `providers/deepseek/spoofing.ts` — builds browser-like headers (sec-ch-ua, user-agent, accept-language, cookies) and spoofed cookie strings with smidV2, ds_session_id, .thumbcache, and aws-waf-token. (#deepseek, spoofing.ts)
- **DeepSeek PoW Solver**: New `providers/deepseek/pow.ts` — solves DeepSeekHashV1 PoW via WASM (WebAssembly.instantiate) or browser profile fallback (page.evaluate). Uses SHA3 WASM from fe-static.deepseek.com. Caches solutions within expire_after TTL. (#deepseek, pow.ts)
- **DeepSeek Session Management**: New `providers/deepseek/session.ts` — `getCurrentUser()` (from /api/v0/users/current), `getOrCreateChatSession()` (30min TTL cache), `clearSessionCache()`. (#deepseek, session.ts)
- **DeepSeek Custom SSE Parser**: New `providers/deepseek/stream.ts` — parses DeepSeek's JSON Patch-like protocol (v/p/o/BATCH operations) into OpenAI chat.completion.chunk format with thinking/reasoning support. (#deepseek, stream.ts)
- **GLM Spoofing Module**: New `providers/glm/spoofing.ts` with browser fingerprint params (20+ fields), x-signature HMAC-SHA256 via Web Crypto API, and GLM variable builder. (#glm, spoofing.ts)
- **GLM Session Management**: New `providers/glm/session.ts` with `getCurrentUser()`, `getOrCreateChatSession()` (30min TTL cache), and `clearSessionCache()`. (#glm, session.ts)
- **GLM Three-Phase SSE Parser**: New `providers/glm/stream.ts` — parses `thinking`/`answer`/`other`/`done` phases into OpenAI chat.completion.chunk format with `reasoning_content` deltas. (#glm, stream.ts)
- **GLM Pipeline Rewrite**: `providers/glm/pipeline.ts` rewritten to use all new modules — spoofing, sessions, three-phase SSE parsing, full fingerprint query string, x-signature headers, and captcha solving support. (#glm, pipeline.ts)
- **GLM Login JWT Extraction**: `services/glmLogin.ts` updated to extract GLM JWT from `autoLoginViaBrowser()` token output (ES256 JWT from signin API). (#glm, glmLogin.ts)
- **Per-Provider Account Tables**: Three separate panels (Qwen, DeepSeek, GLM) each with their own table filtered by `configuredProviders`. Each shows per-provider auth status, per-provider disable toggle, and dedicated login button. (#accounts, accounts.ts/accounts.js/accounts.css)
- **Provider Auth Detail API**: `getAccountStats()` now returns per-provider `providerAuth` with `status` (live/expired/disconnected/pending/connecting), `tokenExpiresInMs`, and `lastLoginAttempt`. (#api, accountManager.ts)
- **Shared Manual Browser Login**: `manualBrowserLogin()` extracted to `loginHelpers.ts` — one reusable function with `beforeFill` callback and `authPagePaths` config for provider-specific login flows. (#auth, loginHelpers.ts)
- **Per-Provider Disable**: `disabledProviders: string[]` on `AccountEntry` replaces single boolean `disabled`. Each provider table can disable its own provider per account. (#accounts, accountManager.ts/accounts.js)
- **Provider Persistence**: `providers` and `disabledProviders` arrays now persisted to `auth.json` (were only in-memory). (#accounts, accountManager.ts)
- **Configure Provider Keys Modal**: New modal in accounts page for setting DeepSeek and GLM API keys per account. (#accounts, accounts.ts/accounts.js)
- **Login Endpoint for Each Provider**: Dedicated GET endpoints for Qwen (`/autofill`), DeepSeek (`/login/deepseek`), GLM (`/login/glm`). (#api, dashboardRoutes.ts/routes/accounts.ts)
- **Poll Provider Login**: Per-provider polling that watches `providerAuth[provider].status === 'live'` instead of generic auth check. (#accounts, accounts.js)

### Changed
- **DeepSeek Pipeline Rewrite**: `providers/deepseek/pipeline.ts` completely rewritten — uses spoofing module for browser headers, PoW solver for DeepSeekHashV1, session management for chat sessions, and custom SSE parser for proper stream handling. Browser spoofing covers all x-client-*, sec-ch-*, and cookie headers. (#deepseek, pipeline.ts)
- **DeepSeek Login Updated**: `services/deepseekLogin.ts` updated — uses existing `extractProviderToken()` in `autoLoginViaBrowser()` with `provider: 'deepseek'`, plus manual login fallback that extracts Bearer token from localStorage or /api/v0/users/current. (#deepseek, deepseekLogin.ts)
- **Project Renamed**: `qwen-gate` → `opengate` across all code, docs, README, package.json, URLs, and config references. No longer Qwen-specific. (#config, all files)
- **All Providers Use Manual Browser Login**: DeepSeek changed from headless auto-login (`loginDeepSeek()`) to headed browser autofill matching Qwen and GLM approach. User clicks Login → browser opens with credentials filled → user solves captcha → browser closes. (#auth, deepseekLogin.ts/dashboardRoutes.ts)
- **Provider Key `zai` → `glm`**: Internal provider key renamed from `zai` to `glm` everywhere — files (`zaiLogin.ts` → `glmLogin.ts`), directories (`providers/zai/` → `providers/glm/`), API routes (`/login/zai` → `/login/glm`), CSS classes (`.zai` → `.glm`), JS identifiers, model ID prefixes (`zai/` → `glm/`). Display label unchanged ("GLM"). (#providers, many files)
- **Data Directory `.qwen/` → `.auth/`**: All auth state files moved to `.auth/`. `accounts.json` → `auth.json`, `accounts.jsonc` → `auth.jsonc`, `master.key`, `browser-profiles/`, `tokens/`, `monitor.json`, `gate.pid` all relocated. Automatic migration from old paths on startup. (#config, accountManager.ts/auth.ts/browserProfiles.ts/monitorStore.ts/cli.ts)
- **Anti-Bot Typing**: `manualBrowserLogin()` auto-fill uses `pressSequentially()` with random delays (30-80ms per keystroke) instead of instant `fill()` — avoids bot detection that flags paste-based input. (#auth, loginHelpers.ts)
- **Qwen Login Endpoint Changed**: Qwen manual login now uses `/api/accounts/:email/autofill` (GET, non-blocking) matching DeepSeek and GLM pattern. (#api, dashboardRoutes.ts)
- **DeepSeek Login Route Changed**: POST `/api/accounts/:email/login/deepseek` changed to GET, returns immediately with async browser launch (non-blocking, user polls for completion). (#api, dashboardRoutes.ts)

### Removed
- **Dead Code**: Removed unused `loginDeepSeek()` headless auto-login function (no longer called from any route). (#auth, deepseekLogin.ts)

### Fixed
- fix: DeepSeek token extraction from localStorage instead of cross-origin fetch (page.evaluate fetch failed on about:blank) — uses localStorage.userToken after navigation, plus server-side validation to skip stale tokens (#deepseek, browserProfiles.ts)
- fix: DeepSeek auto-login no longer uses cookie fallback for token-based auth (cookies don't contain the Bearer token needed by DeepSeek API) — falls through to fresh login when extraction returns null (#deepseek, browserProfiles.ts)
- fix: DeepSeek sign-in email input selector case-sensitivity (CSS `*=Email` didn't match `placeholder="Phone number / email address"`) and Enter key fallback when no submit button (#deepseek, browserProfiles.ts)
- fix: GLM pipeline headers — restored x-signature HMAC, Authorization header, x-fe-version=prod-fe-1.1.67, Chrome/149 UA, full browser Cookie string with all cookies, lang + sec-fetch headers, empty referer (#glm, spoofing.ts, pipeline.ts, browserProfiles.ts, auth.ts, glmLogin.ts, loginHelpers.ts, accountManager.ts)
- fix: DeepSeek tool now sends aws-waf-token cookie + correct referer + search_enabled=true (#deepseek, pipeline.ts, spoofing.ts, browserProfiles.ts)
- fix: GLM tool now sends captcha_verify_param + stream=true + reasoning_effort=max + separate id UUID (#glm, pipeline.ts, browserProfiles.ts, types/auth.ts)
- fix: DeepSeek non-streaming response extraction now handles JSON-patch APPEND format (#deepseek, pipeline.ts)
- **wreq-js Session Leak**: Explicitly close wreq-js sessions after every use to prevent tokio epoll `Bad file descriptor` crash. Sessions were created per-request (5-10 per request) but never disposed — the Rust tokio runtime continued polling on epoll fds after JS GC'd the wrapper objects. Now all sessions are closed on completion, error, and background timer paths.
- **All Providers Use Persistent Browser Profile**: `manualBrowserLogin()` now uses `setupBrowserContext()` (persistent profile + `humanize:true`) instead of ephemeral `chromium.launch()`. DeepSeek and GLM login now persist cookies to disk like Qwen — no re-login on restart. Also checks for existing valid session cookies to skip re-login entirely when profile has live session. (#auth, browserProfiles.ts/loginHelpers.ts)
- **manualBrowserLogin Blank Page Fix**: Use `context.newPage()` instead of `context.pages()[0]` to avoid stale about:blank pages from persistent context session restore. Use `waitUntil: 'networkidle'` instead of `'domcontentloaded'` — DeepSeek is an SPA that renders after DOM parse. (#auth, loginHelpers.ts)
- **DeepSeek/GLM Headless Auto-Login**: Added `autoLoginViaBrowser()` in `browserProfiles.ts` — generic stealth headless auto-login (persistent profile, `humanize:true`, credential fill, captcha detection). DeepSeek and GLM now auto-login silently at startup and dashboard load. Manual headed login only fires on "Login" button click. (#auth, browserProfiles.ts/deepseekLogin.ts/glmLogin.ts/auth.ts/dashboardRoutes.ts/accounts.js)
- fix: DeepSeek handler arg mismatch (token passed as accountEmail) (#deepseek, handler.ts:15)
- fix: GLM pipeline body shape (features/background_tasks objects, signature_prompt) and query version constant (#glm, pipeline.ts+spoofing.ts)
- fix: DeepSeek session creation needs spoofed browser headers + error logging (#deepseek, session.ts)
- fix: GLM login now only uses existing browser session (no fresh login attempt that triggers Aliyun captcha) (#glm, glmLogin.ts, browserProfiles.ts)


## [0.7.1] - 2026-06-23

### Changed
- **Per-Request wreq-js Sessions**: Switch to fresh wreq-js session per request to avoid tokio epoll/Bun event loop conflict (`Bad file descriptor` panic).
- **Single File Upload**: Merged `system.txt` + `tool-result.txt` into one `context.txt` with `<system-instructions>` and `<tool-results>` sections. Cuts upload latency in half (4 network hops instead of 8).
- **Parse Poll Timeout**: Reduced `pollParseStatus` max wait from 60s to 5s. Worst-case upload delay from 60s to 5s.
- **Boot Account Config**: Apply system prompt + disable native tools at startup via `configureAccount()` call.

### Fixed
- **System Prompt Clarity**: Updated `defaultSystemPrompt.ts` — tool results are file-only, removed misleading "identical to instructions" claim.
- **Dead Code**: Removed unused `applyRequestJitter` function from `qwen.ts`.

## [0.7.0] - 2026-06-22

### Changed
- **Browserless Fetch Stack**: Replaced Playwright entirely with wreq-js based Qwen API interaction. No browser needed for requests.
- **bx-ua Generator**: Pure Node.js UA generation replaces Playwright extraction.
- **Test Mode Fetch**: `browserlessFetch` uses `globalThis.fetch` in test mode.
- **Removed Playwright Dependency**: Removed from `getBasicHeaders()`, removed dead playwright import and `buildRequestHeaders` from `qwen.ts`.

## [0.6.0] - 2026-06-19

### Added
- **Auto-Upload Large Payloads**: Large payloads auto-upload as Qwen file attachments. Latest user message stays inline, history goes to file.
- **Dark Mode Toggle**: Added dark mode toggle in sidebar.
- **Typed Config**: Password master key, health endpoint, rate limiting.

### Changed
- **Node.js Fetch for All API Calls**: Removed CDP routing. All API calls go through Node.js fetch.
- **Headless Detection Evasion**: UA rotation and bot detection logging.
- **Per-Account CDP Browser Contexts**: Startup order fixes, bot detection logging, account routing fixes.
- **Upload Format**: XML tool result format, .txt file uploads, system prompt update.
- **Dashboard**: Logs page removed from dashboard.
- **Code Quality**: Biome format, bug fixes, dead code removal, docs audit.

### Fixed
- **Qwen CAPTCHA Detection**: Handles `FAIL_SYS_USER_VALIDATE` CAPTCHA responses.
- **Browser Context Leak**: Orphan process prevention.
- **Session Pool Hang**: Fixed `sessionPool.acquire()` from hanging indefinitely.

## [0.5.1] - 2026-06-16

### Changed
- **Bun-first runtime**: Prefer bun install over npm everywhere, npm stays as fallback
- Added `bunx playwright install` as primary browser install method (npx as fallback)
- Removed `2>/dev/null` silencing from bin/opengate so install errors are visible
- Various code quality fixes (circuit breaker awaits, error handling cleanup)

## [0.5.0] - 2026-06-14

### Fixed
- **Stream Idle Timeout Hang**: Upstream silence no longer hangs the client indefinitely. Catches timeout gracefully, writes error SSE event + `[DONE]`, logs to dashboard. Default timeout 45s, configurable via `STREAM_IDLE_TIMEOUT_MS`.
- **Tool Call Content Leak**: Streaming tool call XML fragments (`<function=`, `=filePath>`, `-edit`) no longer leak into emitted content. Uses `toolCallDepth` state counter + per-chunk detection.
- **Timing-Safe API Key**: Config route now uses constant-time comparison (`safeCompare`) for API key check.

### Changed
- **Data-Driven Stripping**: All tag names centralized in `src/utils/tagNames.ts`. `TOOL_CALL_KEYWORDS`, `THINK_TAG_NAMES`, `TOOL_RESULT_KEYWORDS` arrays drive regex construction in all 8 stripping sites. No hardcoded regex patterns.
- **Deduplication**: Think tag regex consolidated from 5 sites → 1 shared. Newline normalization unified to `\n{3,}→\n\n` everywhere. Removed 250+ lines of dead code (`json.ts`, `stripStreamingDelta`, `repairMalformedJson`, unused re-exports).
- **Performance**: `END_TAG_PATTERNS` hoisted to module-level. `IDLE_TIMEOUT_MS` hoisted out of hot loop. Short-circuit guards added to `cleanThinkTags` and `parseXmlToolCalls`.
- **Better Diagnostics**: JSON parse errors log raw data. Stream errors captured in both console and dashboard log.

### Fixed
- **Dashboard Script Injection**: Fixed critical bug where `serveHtml` broke all `<script src="...">` tags when injecting `window.APP_VERSION`. ([#5](https://github.com/youssefvdel/opengate/issues/5))

## [0.4.0] - 2026-06-11

### Added
- **CDP Routing**: Route Qwen API through real Chrome via CDP to bypass baxia WAF.
- **Profile-Based Auth**: Read tokens from Chromium browser profiles directly. Auto-detect system Chrome profiles.
- **Parallel Extraction**: Parallel profile/cookie extraction at startup.

### Changed
- **Per-Account Browser Contexts**: Isolated CDP browser contexts per account.
- **Two-Phase Body Storage**: Large CDP request body storage for 132KB+ payloads.
- **Auth Rewrite**: Removed cookie folder system, refactored to Chromium profile auth.

### Fixed
- **Dashboard Script Injection**: Script injection breaking all dashboard pages (credit @eric).
- **Refresh Token TTL**: Fixed refresh token TTL, saves refresh token + expiry.
- **InFlight Counter Leak**: Fixed inFlight counter leak, deduplicated tool call logging.
- **XML Leak Prevention**: Hardened XML leak prevention across all emission paths.
- **Dashboard with API_KEY**: Fixed dashboard when `API_KEY` is set.

## [0.3.1] - 2026-06-09

### Changed
- **Install Script Fixes**: Removed `set -e`, handle pipes, don't delete node_modules before install.
- **XML Tool Call Parsing**: Improved XML tool call parsing.
- **Per-Account Configuration**: Added per-account configuration support.
- **Install Build Step**: Added build step to install process.

## [0.3.0] - 2026-06-08

### Changed
- **Native XML Tool Calling**: Major refactor to Qwen native XML tool calling — `<function=name>` format replaces JSON tool calling.
- **Single Role User**: Flattened messages to single `role:user` (Qwen limitation).
- **Tool Result Format**: Tool results use `type:function` + `tool:name` format.
- **Removed Echo Detection**: Removed echo detection, reworked XML stripping.

### Added
- **MCP Tool Call Extraction**: Extract MCP tool calls from SSE `extra.local_mcp`.
- **Qwen API Request Logging**: Request logging to `logs/qwen/`.
- **QwenBaseUrl Config**: Added `QwenBaseUrl` config support.
- **Account Failover**: Account failover loop (community PR).

### Fixed
- **Cross-Platform Install Scripts**: Fixed install scripts for cross-platform reliability.

## [0.2.0] - 2026-06-04

### Added
- **Dashboard Web Interface**: Complete vanilla HTML/JS dashboard with 5 pages (overview, logs, accounts, network, settings)
- **Claymorphism Design**: Warm cream/beige color palette with sage green accents (#F5F1EA bg, #5E9D5C accent)
- **Unified Sidebar Navigation**: Consistent navigation across all dashboard pages
- **12-Hour Time Format**: All timestamps now display in 12-hour AM/PM format
- **100% Width Layout**: Dashboard pages use full available width
- **CLI Tool `opengate`**: Command-line interface for account management (login, list, remove)
- **One-Command Install Script**: `curl -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.sh | bash`
- **Network Debug Page**: View outbound API calls with expandable detail panels
- **System Logs Panel**: Real-time system logs in overview dashboard
- **Session Pool Dashboard**: Live session utilization bar and model health table

### Changed
- **Dashboard Architecture**: Replaced Astro+SolidJS with vanilla HTML/JS (no build step)
- **Browser Automation**: Migrated from Playwright to CloakBrowser for enhanced stealth
- **Dashboard Styling**: Applied Claymorphism design with soft shadows, 16px border radius, and Poppins typography
- **Log Entry Layout**: Two-column grid (70/30 split) with Raw/Processed Output side-by-side
- **Chunk Stream**: Fills 100% height with internal scroll, unfolds by default
- **Network Page**: Fixed JavaScript syntax errors (template literal escaping, `\n` → `\\n`)

### Fixed
- **Thinking Emission Leak**: Deferred thinking emission until after echo detection completes
- **Token Waste**: Abort upstream requests immediately on echo detection
- **Streaming Delta Ordering**: Fixed pattern ordering (B→C→A→D→E) with negative lookbehind
- **Marker Leakage**: Prevented `[READ TOOL RESULT]` marker from appearing in user output
- **Tool Result Echo Filter**: Integrated filter in streaming delta loop
- **API Key Injection**: Fixed template literal escape sequences in network page (`\'` → `"'"`)
- **Browser Profile Tracking**: Added `.gitignore` rules to exclude runtime browser profiles

## [0.1.0] - 2026-05-28

### Added
- **OpenAI-Compatible API Gateway**: Full `/v1/chat/completions` and `/v1/models` endpoints
- **Multi-Account Session Management**: Browser-based authentication with automatic session rotation
- **Streaming Support**: Server-Sent Events (SSE) for real-time chat responses
- **Tool Calling**: Complete OpenAI tool calling protocol with parallel tool execution
- **Echo Detection**: Intelligent detection and filtering of model echo patterns
- **Content Filter Pipeline**: Pluggable filter system for request/response transformation
- **Session Pool**: Pre-authenticated browser session management with automatic refresh
- **Logging System**: Structured JSON logging with request/response capture
- **Account Management**: Add/remove/list accounts via API and CLI
- **Configuration System**: Environment variables, config.json, and runtime config API

### Changed
- **Browser Stealth**: Enhanced anti-detection measures for browser automation
- **Session Refresh**: Improved session TTL management and automatic refresh logic
- **Error Handling**: Structured OpenAI-compatible error responses
- **Rate Limiting**: Per-account rate limiting with automatic cooldown

### Fixed
- **Session Expiry**: Automatic session refresh before expiration
- **Tool Result Parsing**: Fixed edge cases in tool result JSON parsing
- **Stream Interruption**: Graceful handling of upstream stream interruptions
- **Account Rotation**: Fixed round-robin account selection under high load

## [0.0.1] - 2026-05-15

### Added
- Initial project structure
- Basic Hono web server setup
- TypeScript configuration
- Package.json with core dependencies
- Basic README with project description

[0.7.0]: https://github.com/youssefvdel/opengate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/youssefvdel/opengate/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/youssefvdel/opengate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/youssefvdel/opengate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/youssefvdel/opengate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/youssefvdel/opengate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/youssefvdel/opengate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/youssefvdel/opengate/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/youssefvdel/opengate/releases/tag/v0.0.1
