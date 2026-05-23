# Qwen Gate

> **⚠️ Disclaimer**: This project is for **educational and study purposes only**. It is an OpenAI-compatible API gateway that interfaces with Qwen models via chat.qwen.ai. The project is not affiliated with, endorsed by, or sponsored by Alibaba Group, Qwen, or chat.qwen.ai. All Qwen models and the chat.qwen.ai service are the property of their respective owners. Users are responsible for complying with chat.qwen.ai's terms of service. The author assumes no responsibility for misuse, unauthorized access, or any violations of third-party terms.

OpenAI-compatible API gateway for **Qwen models (chat.qwen.ai)** using Playwright browser automation. Supports tool calling, thinking/reasoning, streaming, session autoscaling, and full OpenAI-compatible response formatting.

## Quick Start

```bash
git clone https://github.com/youssefvdel/qwen-gate.git
cd qwen-gate
npm install
npx playwright install chromium
cp .env.example .env
npm start     # Starts on http://localhost:26405
```

## Usage

```bash
# List models
curl http://localhost:26405/v1/models

# Chat (streaming)
curl -N -X POST http://localhost:26405/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen3.7-max", "messages": [{"role": "user", "content": "hello"}], "stream": true}'

# Tool calling
curl -N -X POST http://localhost:26405/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen3.7-max", "messages": [{"role": "user", "content": "read /etc/hostname"}], "tools": [{"type": "function", "function": {"name": "read_file", "description": "Read a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}], "stream": true}'

# Health
curl http://localhost:26405/health
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `26405` | Server port |
| `API_KEY` | — | Optional auth key (protects `/v1/*` and `/log*` routes) |
| `QWEN_EMAIL` | — | Qwen account email for auto-login |
| `QWEN_PASSWORD` | — | Qwen account password for auto-login |
| `BROWSER` | `chromium` | Playwright browser engine |

### Output Control

| Variable | Default | Description |
|---|---|---|
| `TOOL_CALLING` | `true` | Enable tool call parsing. `false` = raw Qwen passthrough |
| `CONTENT_FILTER` | `true` | Strip Qwen's internal `<think>`/`<thinking>` XML tags and redirect reasoning to `reasoning_content`. `false` = disable |
| `CLEAN_OUTPUT` | `true` | Strip backtick fences before parsing. Only applies when `TOOL_CALLING=true` |
| `STREAMING` | — | Force streaming: `true` = always stream, `false` = never stream |
| `NON_STREAMING` | — | Alias for `STREAMING=false` |
| `DEBUG` | — | Enable debug logging (shows raw Qwen chunks vs processed output) |

### Session & Retry

| Variable | Default | Description |
|---|---|---|
| `DELETE_SESSION` | `true` | Delete Qwen chat sessions after use |
| `RETRY_MAX_ATTEMPTS` | `2` | Max retries for failed Qwen requests |
| `RETRY_BASE_DELAY_MS` | `500` | Initial retry delay in ms |
| `RETRY_BACKOFF_MULTIPLIER` | `0.1` | Backoff multiplier per retry |

## Output Format (OpenAI-Compatible)

The gateway produces standard OpenAI streaming format:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"qwen3.7-max","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"qwen3.7-max","choices":[{"index":0,"delta":{"reasoning_content":"Let me think..."},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"qwen3.7-max","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"qwen3.7-max","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"qwen3.7-max","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- **Thinking/reasoning** → `delta.reasoning_content` (separate field, never mixed with content)
- **Answer** → `delta.content` (incremental tokens only)
- **Tool calls** → `delta.tool_calls[]` (structured JSON)
- **No XML tags** in either field — `<think>`, `<thought>`, `<tool_call>` are stripped

## Models

All available Qwen models from chat.qwen.ai are listed at `/v1/models`. Append `-no-thinking` to any model ID to disable the reasoning phase.

## Tool Calling

The gateway supports OpenAI-compatible tool calling. The model is taught to produce pure JSON:

```json
{"name": "read_file", "arguments": {"path": "src/main.ts"}}
```

**Multi-layer defense** ensures reliable output:
1. System prompt teaches correct format
2. Parser strips XML wrappers, markdown fences
3. Content filter removes stray thinking/XML tags
4. JSON repair (trailing commas, unclosed braces)
5. Guard validation (rejects bad names, string args, empty args)
6. Escalating correction prompts (mild → strong → auto-repair)
7. Loop detection (same tool+args 4+ times → force-stop)

### Available Tools

| Tool | Description |
|---|---|
| `bash` | Execute shell commands |
| `read_file` | Read files/directories |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `edit` | Edit files (find/replace) |
| `write_file` | Create/overwrite files |
| `task` | Launch subagents |
| `webfetch` | Fetch URL content |
| `todowrite` | Manage task lists |
| `skill` | Load specialized skills |

## OpenCode Integration

Add to `~/.config/opencode/opencode.json`:

```json
"provider": {
  "qwen-gate": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Qwen Gate",
    "options": { "baseURL": "http://qwen-gate/v1" },
    "models": {
      "qwen3.7-max": { "name": "Qwen3.7 Max", "limit": { "context": 1000000, "output": 81920 } },
      "qwen3.7-max-no-thinking": { "name": "Qwen3.7 Max (No Thinking)", "limit": { "context": 1000000, "output": 81920 } },
      "qwen3.6-plus": { "name": "Qwen3.6 Plus", "limit": { "context": 1000000, "output": 65536 } },
      "qwen3.6-plus-no-thinking": { "name": "Qwen3.6 Plus (No Thinking)", "limit": { "context": 1000000, "output": 65536 } }
    }
  }
}
```

## Architecture

```
Client → Qwen Gate → Playwright (bx-headers) → chat.qwen.ai API
```

- **Session management**: Each request gets a fresh Qwen chat session, deleted after use
- **Headers**: Extracted automatically from Playwright page API calls (bx-umidtoken, bx-ua)
- **Auth**: Cookie-based session maintained via Playwright browser context
- **Streaming**: SSE-based with heartbeat keep-alive, incremental delta emission
- **Logging**: `/log` dashboard with raw vs processed output comparison, SSE live updates

## Docker

```bash
docker compose up --build
```
