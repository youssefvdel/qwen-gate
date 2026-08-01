# OpenGate

<p align="center">
  <img src="media/banner.svg" alt="OpenGate Banner" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3+-pink.svg)](https://bun.sh/)
[![GitHub Release](https://img.shields.io/github/v/release/youssefvdel/opengate)](https://github.com/youssefvdel/opengate/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Browserless](https://img.shields.io/badge/Stack-Browserless-8B5CF6)](https://bun.sh)

> **Disclaimer**: This project is for educational and study purposes. It provides access to Qwen models via `chat.qwen.ai`, DeepSeek models via `chat.deepseek.com`, and GLM models via `chat.z.ai` browser automation. Not affiliated with Alibaba Group, Qwen, DeepSeek, or Zhipu AI. Users must comply with each provider's terms of service.

---

## Quick Start

```bash
curl -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.sh | bash
cd opengate
opengate
```

Then open [http://localhost:26405/dashboard](http://localhost:26405/dashboard) to add accounts and start using the API.

## Features

- **Free Qwen Models** — Use Qwen 3.7-Max, Qwen 3-Max, Qwen 3-Plus, and more for free in your existing tools. Point Claude Code, OpenCode, Qwen Code, Cursor, Hermes, or any OpenAI-compatible client at OpenGate and use Qwen models without paying per-token.
- **Free DeepSeek Models** — Instant, Expert (DeepThink/R1 reasoning), and Vision modes via `chat.deepseek.com`, including `deepseek-v4-flash` / `deepseek-v4-pro` aliases with 1M context. Reasoning enabled by default.
- **Free GLM Models** — GLM-5.2, GLM-4.7, and more via `chat.z.ai`.
- **OpenAI-Compatible API** — Drop-in replacement for `/v1/chat/completions` and `/v1/models`. Works with existing OpenAI SDKs, curl, or any HTTP client.
- **Multi-Provider Accounts** — Configure multiple accounts for Qwen, DeepSeek, and GLM. Requests are distributed via round-robin with automatic failover and cooldown tracking — cooldown limits become a non-issue.
- **Agentic Tool Calling** — Full OpenAI-style function calling with JSON Schema validation and spam guards. DeepSeek tool calling is *emulated* (the web API has no native function calling): tool schemas are injected with a strict JSON-array output contract and parsed from the model output — **parallel tool calls** (Hermes-style agents) work in both streaming and non-streaming modes.
- **Streaming SSE** — Server-Sent Events with heartbeat keep-alive and content filter integrity maintained across stream boundaries.
- **Content Filter Pipeline** — Strips thinking tags and filters internal artifacts from model output.
- **Web Dashboard** — Real-time monitoring with 5 pages: overview, request log, account manager, network debug, and settings.
- **Dual Transport** — Pure Node.js fetch via wreq-js for requests, Playwright browser automation for login/auth only. No browser needed for API calls.
- **File Upload** — Large context payloads auto-uploaded as Qwen file attachments. Context above limit goes to `context.txt`, latest user message stays inline for low latency.
- **No Build Step** — TypeScript executed directly via Bun. Run from source with no compilation needed.
- **Bun-Powered** — Native TypeScript execution, built-in test runner, and cluster mode for multi-core utilization.

## Installation

### One-Command Install (Linux / macOS)

```bash
curl -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.sh | bash
```

This clones the repo, installs dependencies, creates `config.json`, and symlinks the `opengate` / `opengate` / `opengate` CLI commands.

### Windows Install

Open **PowerShell** (as administrator) and run:

```powershell
powershell -ExecutionPolicy Bypass -c "curl.exe -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.ps1 | iex"
```

Or clone manually:

```powershell
git clone https://github.com/youssefvdel/opengate.git
cd opengate
bun install
```

Then run `opengate` to start the server.

### Manual Install

```bash
git clone https://github.com/youssefvdel/opengate.git
cd opengate
bun install
```

### Start the Server

```bash
opengate
```

Or:

```bash
bun start
```

The server starts on [http://localhost:26405](http://localhost:26405).

### Add Accounts

> **⚠️ Best practice:** Use **3+ accounts** for round-robin rotation to bypass cooldown limits. Do **not** use your personal Qwen account — create dedicated accounts.

1. Open [http://localhost:26405/dashboard/accounts](http://localhost:26405/dashboard/accounts)
2. Enter your Qwen email and password
3. Click **Add Account** — the gateway handles login and session persistence

## Usage

### Use with Any OpenAI-Compatible Client

OpenGate works with any tool that speaks OpenAI's API: **Claude Code, OpenCode, Qwen Code, Cursor**, standard OpenAI SDKs (Python, Node.js, curl), and anything else using the `/v1/chat/completions` format — just point it at `http://localhost:26405/v1`.

> **Tip:** Use `model: "qwen3-7-max"` for the latest Qwen model. Available models: `qwen3-7-max`, `qwen3-6-plus`, `qwen3-max`, `qwen3-coder`, `qwen3-5-plus`, `qwen3-5-flash`, and more.
>
> **DeepSeek:** `deepseek/deepseek-chat` (Instant), `deepseek/deepseek-reasoner` (Expert/DeepThink), `deepseek/deepseek-vision`, or the 1M-context `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro` aliases. Bare names like `deepseek-v4-flash` (no `deepseek/` prefix) work too.
>
> **GLM:** `glm/glm-5.2`, `glm/glm-4.7`, `glm/glm-4.7-flash`, and more.

### Chat Completion

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen3-max",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

Set `"stream": true` for SSE:

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model": "qwen3-max", "stream": true, "messages": [{"role": "user", "content": "Count to 5"}]}'
```

### Tool Calling

> **How it works:** Qwen doesn't natively support tool calling — it outputs tool calls as JSON text in its response. The gateway parses that text and converts it into OpenAI-compatible tool call objects. It's not perfect, but it works for most use cases.

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen3-max",
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

## Configuration

All settings in `config.json`. Key options:

| Key                       | Default      | Description                                     |
| ------------------------- | ------------ | ----------------------------------------------- |
| `PORT`                    | `"26405"`    | Server port                                     |
| `API_KEY`                 | `""`         | Bearer token for API auth (empty = no auth)     |
| `BROWSER`                 | `"chromium"` | Browser engine: `chromium`, `firefox`, `webkit`, `chrome`, `edge` |
| `TOOL_CALLING`            | `"true"`     | Enable tool call parsing                        |
| `CLEAN_OUTPUT`            | `"true"`     | Strip internal artifacts from responses         |
| `STREAMING_MODE`           | `"auto"`     | Streaming mode: `auto`, `on`, `off`             |
| `SAVE_REQUEST_LOGS`       | `"false"`    | Save per-request logs to disk                   |
| `OPEN_DASHBOARD_ON_START` | `"false"`    | Auto-open dashboard in browser                  |
| `RATE_LIMIT_COOLDOWN_MS`  | `"120000"`   | Cooldown after rate limit (2 min)               |
| `RETRY_MAX_ATTEMPTS`      | `"3"`        | Max retry attempts                              |
| `DEEPSEEK_THINKING`       | `"true"`     | Enable DeepSeek reasoning (thinking_enabled)    |
| `STREAM_IDLE_TIMEOUT_MS`  | `"60000"`    | Idle timeout for upstream streams               |
| `MODELS_CACHE_TTL_MS`     | `"3600000"`  | Model list cache TTL (ms)                       |
| `CLAUDE_CODE_PROXY`       | `"false"`    | Claude Code proxy mode                          |

> **Note:** This is a partial list of commonly-used keys. See `ConfigSchema` in `src/services/configService.ts` for the full list.

## Architecture

<p align="center">
  <img src="media/architecture.svg" alt="OpenGate Architecture Diagram" width="100%">
</p>

## Web Dashboard

Accessible at `http://localhost:26405/dashboard`.

| Page         | Path                  | Purpose                                              |
| ------------ | --------------------- | ---------------------------------------------------- |
| **Overview** | `/dashboard`          | KPIs, model health, system logs, session pool status |
| **Logs**     | `/dashboard/logs`     | Real-time request log with expandable entry details  |
| **Accounts** | `/dashboard/accounts` | Add/remove Qwen accounts, view auth status           |
| **Network**  | `/dashboard/network`  | Outbound API call inspector                          |
| **Settings** | `/dashboard/settings` | Live config editor (changes apply instantly)         |

## CLI

Binary alias: `opengate`.

```text
Usage: opengate [command] [options]

Commands:
  start          Start the API server (default)
  update         Pull latest code and reinstall dependencies
  restart        Restart the running server
  status         Check if the server is running
  help           Show help message

Options:
  --port <n>     Override port
  --browser <e>  Browser engine: chromium, firefox, webkit, chrome, edge
  --host <addr>  Bind address

Account management is done via the web dashboard → Accounts page.
```

## Updating

### Via CLI (easiest)

```bash
opengate update
```

This runs `git pull --ff-only && bun install`. Then restart the server:

```bash
opengate restart
```

### Manual

```bash
git pull && bun install && opengate restart
```

### Re-run the installer

```bash
# Linux / macOS
curl -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.sh | bash

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -c "curl.exe -sSL https://raw.githubusercontent.com/youssefvdel/opengate/main/install.ps1 | iex"
```

The server checks for new GitHub releases on startup and logs a warning in the dashboard when an update is available.

## Project Structure

```text
src/
├── cli.ts                   CLI entry (opengate command parser)
├── cluster.ts               Multi-core cluster mode
├── index.tsx                Hono server, routing, CORS, auth
├── routes/                  API route handlers
│   ├── chat.ts              Chat completions dispatch
│   ├── chatHelpersCore.ts   Core chat response handling
│   ├── compressToolResult.ts Tool result compression
│   ├── writeHelpers.ts      Write helper utilities
│   ├── accounts.ts          Account CRUD API
│   ├── config.ts            Config read/write API
│   ├── providerRegistry.ts  Provider prefix → handler routing
│   ├── openaiProxy.ts       OpenAI proxy passthrough
│   ├── anthropic.ts         Anthropic-compatible endpoint
│   ├── chat.ts              Qwen chat completions dispatch (via providers/qwen/)
│   ├── providerGlm.ts / providerDeepSeek.ts  GLM/DeepSeek provider entry points
│   ├── providers/           Per-provider implementations
│   │   ├── qwen/            Qwen web chat (session, pipeline, stream)
│   │   ├── glm/             GLM web chat (session, captcha, pipeline, stream)
│   │   └── deepseek/        DeepSeek web chat
│   │       ├── handler.ts   Retry loop + account rotation + telemetry
│   │       ├── pipeline.ts  PoW → session → chat → SSE → OpenAI format
│   │       ├── toolEmulation.ts  Agentic tool-call emulation (parallel calls)
│   │       ├── pow.ts       WASM Proof-of-Work solver (single-use)
│   │       ├── leim.ts      hif-leim WAF bypass token
│   │       ├── stream.ts    JSON-patch SSE parser
│   │       └── session.ts   Chat session management
│   ├── modelSpecs.ts         Model spec definitions
│   └── dashboard/           Web dashboard (vanilla HTML/JS)
│       ├── dashboardRoutes.ts  Dashboard routing hub
│       ├── overview.ts / logs.ts / accounts.ts / network.ts / settings.ts
│       ├── sidebar.ts       Sidebar navigation
│       └── public/          Static dashboard assets (JS/CSS)
├── services/                Business logic
│   ├── accountManager.ts    Account CRUD, round-robin rotation
│   ├── auth.ts              Auth orchestration + provider pool stats
│   ├── configService.ts     Config loader (typed accessors)
│   ├── logStore.ts          In-memory log store + SSE
│   ├── modelRouter.ts       Model routing & fallback
│   ├── sessionPool.ts       Qwen session pool with autoscaling
│   ├── qwen.ts / glmLogin.ts / deepseekLogin.ts   Provider login flows
│   ├── browserProfiles.ts   Browser profile management
│   ├── qwenFileUpload.ts    Qwen file upload handling
│   ├── qwenModels.ts        Qwen model fetching & mapping
│   ├── providerModelsService.ts  Provider model catalog service
│   └── ...
├── tools/                   Tool calling system (Qwen XML parsing)
│   ├── xmlToolParser.ts     XML tool call parsing
│   └── guard.ts             Spam/abuse guard
├── utils/                   Shared utilities
│   ├── retry.ts             Exponential backoff (429-aware)
│   ├── contentFilter.ts     Streaming content filter
│   ├── tokenEstimator.ts    Token estimation
│   └── providerModels.ts    Static DeepSeek/GLM model catalog + context specs
├── tests/                   Integration tests
├── types/                   TypeScript interfaces
└── middleware/
    └── rateLimit.ts         Token bucket rate limiter
```

## Testing

```bash
bun test
```

Uses Bun's built-in test runner. Covers content filtering, tool-call parsing, streaming sanitization, bx-ua generation, and config service.

## Documentation

| Document                             | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md) | System design, component breakdown, data flow |
| [API Reference](docs/API.md)         | Full endpoint documentation                   |
| [Deployment](docs/DEPLOYMENT.md)     | Production deployment guide                   |
| [Development](docs/DEVELOPMENT.md)   | Contributing, testing, code conventions       |
| [Release v0.7.2](docs/RELEASE-v0.7.2.md) | DeepSeek agentic tool-call emulation release notes |


## License

MIT — see [LICENSE](LICENSE).
