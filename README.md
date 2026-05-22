# Qwen Gate

OpenAI-compatible API gateway for **Qwen models (chat.qwen.ai)** using Playwright browser automation. Supports tool calling, thinking/reasoning, streaming, and session autoscaling.

## Quick Start

```bash
# Clone
git clone https://github.com/youssefvdel/qwen-gate.git
cd qwen-gate

# Install
npm install
npx playwright install chromium

# Configure
cp .env.example .env
# Add QWEN_EMAIL and QWEN_PASSWORD if you want auto-login

# Run
npm start
```

The proxy starts on `http://localhost:3000`.

## Usage

```bash
# List models
curl http://localhost:3000/v1/models

# Chat (non-streaming)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen3.6-plus-no-thinking", "messages": [{"role": "user", "content": "hello"}]}'

# Streaming
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen3.6-plus-no-thinking", "messages": [{"role": "user", "content": "hello"}], "stream": true}'

# Health
curl http://localhost:3000/health
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `API_KEY` | — | Optional auth key |
| `QWEN_EMAIL` | — | Qwen account email |
| `QWEN_PASSWORD` | — | Qwen account password |
| `BROWSER` | `chromium` | Playwright browser engine |

## Models

- `qwen3.6-plus` / `qwen3.6-plus-no-thinking`
- `qwen3.7-max` / `qwen3.7-max-no-thinking`
- `qwen3.6-max-preview` / `qwen3.6-max-preview-no-thinking`

Append `-no-thinking` to disable the reasoning phase for faster responses.

## OpenCode Setup

Add this to your `~/.config/opencode/opencode.json`:

```json
"provider": {
  "qwen-gate": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Qwen Gate",
    "options": {
      "baseURL": "http://qwen-gate/v1"
    },
    "models": {
      "qwen3.7-max": {
        "name": "Qwen3.7 Max",
        "limit": { "context": 1000000, "output": 81920 }
      },
      "qwen3.7-max-no-thinking": {
        "name": "Qwen3.7 Max (No Thinking)",
        "limit": { "context": 1000000, "output": 81920 }
      },
      "qwen3.6-plus": {
        "name": "Qwen3.6 Plus",
        "limit": { "context": 1000000, "output": 65536 }
      },
      "qwen3.6-plus-no-thinking": {
        "name": "Qwen3.6 Plus (No Thinking)",
        "limit": { "context": 1000000, "output": 65536 }
      }
    }
  }
}
```

The setup script (`npm run setup`) does this automatically.

## Docker

```bash
docker compose up --build
```

## Architecture

```
Client → Qwen Gate → Playwright (bx-headers) → Qwen API
```

- **Each request** creates a fresh Qwen chat session and deletes it after use
- **Headers** extracted automatically from page API calls (no UI interaction needed)
- **Sessions** auto-scaled per request, no pool, no history leaks
- **English instruction** set automatically on first request
