# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] - 2026-06-23

### Fixed
- **wreq-js Session Leak**: Explicitly close wreq-js sessions after every use to prevent tokio epoll `Bad file descriptor` crash. Sessions were created per-request (5-10 per request) but never disposed — the Rust tokio runtime continued polling on epoll fds after JS GC'd the wrapper objects. Now all sessions are closed on completion, error, and background timer paths.

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
- Removed `2>/dev/null` silencing from bin/qg so install errors are visible
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
- **Dashboard Script Injection**: Fixed critical bug where `serveHtml` broke all `<script src="...">` tags when injecting `window.APP_VERSION`. ([#5](https://github.com/youssefvdel/qwen-gate/issues/5))

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
- **CLI Tool `qg`**: Command-line interface for account management (login, list, remove)
- **One-Command Install Script**: `curl -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash`
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

[0.7.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/youssefvdel/qwen-gate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/youssefvdel/qwen-gate/releases/tag/v0.0.1
