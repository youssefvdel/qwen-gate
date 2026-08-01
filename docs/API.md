# OpenGate API Reference

Complete API documentation for OpenGate's OpenAI-compatible endpoints.

## Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Rate Limits](#rate-limits)
- [Endpoints](#endpoints)
  - [Chat Completions](#post-v1chatcompletions)
  - [Models](#get-v1models)
- [Dashboard Routes](#dashboard-routes)
- [Error Handling](#error-handling)
- [SDKs and Clients](#sdks-and-clients)

## Base URL

```
http://localhost:26405/v1
```

In production, replace `localhost:26405` with your server address.

## Authentication

All API requests require an API key (if configured):

```bash
Authorization: Bearer YOUR_API_KEY
```

Set your API key in `.env` or `config.json`:

```bash
API_KEY=your_secret_key_here
```

Leave `API_KEY` empty to disable authentication.

## Rate Limits

OpenGate implements rate limiting to protect Qwen accounts:

- **Default cooldown**: 2 minutes per account after rate limit
- **Configurable**: Set `RATE_LIMIT_COOLDOWN_MS` in config
- **Automatic retry**: Failed requests are retried with exponential backoff

## Endpoints

### POST /v1/chat/completions

Create a chat completion. Supports both streaming and non-streaming responses.

#### Request Headers

```http
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

#### Request Body

| Parameter     | Type          | Required | Default | Description                   |
| ------------- | ------------- | -------- | ------- | ----------------------------- |
| `model`       | string        | Yes      | -       | Model name (e.g., `qwen-max`) |
| `messages`    | array         | Yes      | -       | Array of message objects      |
| `stream`      | boolean       | No       | `true`  | Enable streaming response     |
| `temperature` | number        | No       | `0.7`   | Sampling temperature (0-2)    |
| `max_tokens`  | number        | No       | `1000`  | Maximum tokens to generate    |
| `top_p`       | number        | No       | `0.9`   | Nucleus sampling parameter    |
| `tools`           | array         | No       | -       | Array of tool definitions                     |
| `tool_choice`     | string/object | No       | `auto`  | Tool selection strategy                       |
| `stream_options`  | object        | No       | -       | Streaming options. Set `{"include_usage": true}` to get usage data in the final chunk |

#### Message Object

```json
{
  "role": "user|assistant|system|tool",
  "content": "string",
  "name": "string (optional)",
  "reasoning_content": "string (optional, assistant messages only)",
  "tool_calls": [],
  "tool_call_id": "string (for tool messages)"
}
```

#### Basic Example

**Request:**

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

**Response (streaming):**

The server sends SSE (Server-Sent Events) with an initial heartbeat, then role assignment, content deltas, and optional reasoning deltas. Each chunk is OpenAI-compatible.

```
: heartbeat

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","system_fingerprint":"fp_opengate","service_tier":"default","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{"content":"! How can I help you today?"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","system_fingerprint":"fp_opengate","service_tier":"default","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":10,"total_tokens":25,"completion_tokens_details":{"reasoning_tokens":0},"prompt_tokens_details":{"cached_tokens":0}}}

data: [DONE]
```

For models with thinking/reasoning, additional chunks include `reasoning_content` in the delta:

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{"reasoning_content":"Let me think about this step by step..."},"logprobs":null,"finish_reason":null}]}
```

**Response (non-streaming):**

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "qwen-max",
  "system_fingerprint": "fp_opengate",
  "service_tier": "default",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25,
    "completion_tokens_details": {
      "reasoning_tokens": 0
    },
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  }
}
```

#### Tool Calling Example

**Request:**

```json
{
  "model": "qwen-max",
  "messages": [{ "role": "user", "content": "What's the weather in Tokyo?" }],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name"
            }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**Response:**

```json
{
  "id": "chatcmpl-456",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "qwen-max",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\": \"Tokyo\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

**Follow-up with tool result:**

```json
{
  "model": "qwen-max",
  "messages": [
    { "role": "user", "content": "What's the weather in Tokyo?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"location\": \"Tokyo\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"temperature\": 22, \"condition\": \"sunny\"}"
    }
  ]
}
```

#### DeepSeek Tool Calling (Emulated)

> **How it works:** `chat.deepseek.com`'s web API has **no native function calling** — a `tools` field in the body is silently ignored and the model answers in plain text. OpenGate *emulates* it: tool schemas are injected into the prompt with a strict JSON-array output contract (appended at the **end**, where the model generates immediately after reading it), and the model's text output is parsed into structured `tool_calls`. It's heuristic — if the output can't be parsed, the response falls back to plain text (no tool call).

**Parallel tool calls** are fully supported: agents like Hermes that issue multiple simultaneous `tool_calls` (e.g. reading several files at once) work in both streaming and non-streaming modes. For DeepSeek requests with a `tools` array, the pipeline:

1. Appends the tool-calling protocol block to the end of the prompt — the contract requires the response to be exactly one of: a JSON array of tool-call objects, or plain text.
2. Sets `thinking_enabled` from the `DEEPSEEK_THINKING` config (default `true` — reasoning works better with tool calling).
3. Enables `search_enabled` when a `web_search`-style tool is declared.
4. Parses the model output (`parseToolCalls`) — handles JSON arrays (parallel calls), single objects, code fences, and prose-wrapped JSON.
5. Emits all parallel `tool_calls` in non-streaming responses, and indexed `delta.tool_calls` chunks in streaming responses, with a synthesized `finish_reason: "tool_calls"` chunk.

Multi-turn agentic loops work too: assistant `tool_calls` are echoed back and `role: tool` results are serialized as XML-escaped `<tool_result>` blocks resolved by `tool_call_id` (with a "results already received — do NOT call again" note gating re-invocations). Declaring a `web_search`-style tool also enables DeepSeek's native web search (`search_enabled`).

#### Tool Definition

```json
{
  "type": "function",
  "function": {
    "name": "function_name",
    "description": "Description of what the function does",
    "parameters": {
      "type": "object",
      "properties": {
        "param1": {
          "type": "string",
          "description": "Parameter description"
        },
        "param2": {
          "type": "number",
          "description": "Another parameter"
        }
      },
      "required": ["param1"]
    }
  }
}
```

### GET /v1/models

List available models.

#### Request

```bash
curl http://localhost:26405/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3-7-max",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "context_window": 1000000,
      "max_output_tokens": 81920,
      "modalities": ["text"]
    },
    {
      "id": "qwen3-6-plus",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "context_window": 1000000,
      "max_output_tokens": 65536,
      "modalities": ["text", "image", "video"]
    },
    {
      "id": "qwen3-5-flash",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "context_window": 1000000,
      "max_output_tokens": 65536,
      "modalities": ["text", "image", "video"]
    },
    {
      "id": "qwen3-7-max-no-thinking",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "context_window": 1000000,
      "max_output_tokens": 81920,
      "modalities": ["text"]
    }
  ]
}
```

Model names ending in `-no-thinking` disable the thinking/reasoning block for that model.

### Provider Models

In addition to Qwen's dynamic models, OpenGate serves static provider catalogs (DeepSeek, GLM). These entries include `context_window`, `max_output_tokens`, and `modalities` metadata so OpenAI clients get accurate model specs instead of falling back to stale local databases.

```json
{
  "id": "deepseek/deepseek-v4-flash",
  "object": "model",
  "created": 1782414000,
  "owned_by": "deepseek",
  "description": "DeepSeek V4 Flash — alias for Instant (model_type default)",
  "context_window": 1000000,
  "max_output_tokens": 384000,
  "modalities": ["text"]
}
```

#### DeepSeek

| Model | Maps to | Context | Max output |
| ----- | ------- | ------- | ---------- |
| `deepseek/deepseek-instant` | Instant (`model_type default`) | 1M | 384K |
| `deepseek/deepseek-expert` | Expert (`model_type expert`) | 1M | 384K |
| `deepseek/deepseek-vision` | Vision (`model_type vision`) | 32K | 8K |
| `deepseek/deepseek-chat` | Instant (alias) | 1M | 384K |
| `deepseek/deepseek-reasoner` | Expert / DeepThink (alias) | 1M | 384K |
| `deepseek/deepseek-vl2` | Vision (alias) | 32K | 8K |
| `deepseek/deepseek-v4-flash` | Instant (client alias) | 1M | 384K |
| `deepseek/deepseek-v4-pro` | Expert (client alias) | 1M | 384K |

Bare names without the `deepseek/` prefix are also accepted: `deepseek-v4-flash`, `deepseek_chat`, etc.

#### GLM (Zhipu)

`glm/glm-5.2`, `glm/glm-5.1`, `glm/glm-5`, `glm/glm-4.7-flash`, `glm/glm-4.7`, `glm/glm-4.6`, `glm/glm-4.5-air`, `glm/glm-4.5` — all 128K context, 16K max output, text + image modalities.

## Dashboard Routes

The server includes a built-in web dashboard at these routes. All dashboard routes are served as vanilla HTML/JS (no framework dependencies).

| Route                       | Description                          |
| --------------------------- | ------------------------------------ |
| `/dashboard`                | Overview with live request stream    |
| `/dashboard/logs`           | Request log with foldable entries    |
| `/dashboard/accounts`       | Account status and cooldown display  |
| `/dashboard/network`        | Network request inspector            |
| `/dashboard/settings`       | Configuration editor                 |
| `/log`                      | Redirect to `/dashboard/logs`        |

### Log Streaming

The dashboard receives live updates via SSE:

| Route           | Description                               |
| --------------- | ----------------------------------------- |
| `/log/json`     | Recent log entries as JSON                |
| `/log/stream`   | SSE stream of log entries in real time    |

These endpoints share the same `Authorization: Bearer` header as the API. The SSE endpoint accepts an alternative `?token=` query parameter since `EventSource` cannot set custom headers.

## Error Handling

### Error Response Format

```json
{
  "error": {
    "message": "Error description",
    "type": "error_type",
    "param": "field_name (optional)",
    "code": "error_code"
  }
}
```

### Common Errors

#### 400 Bad Request

```json
{
  "error": {
    "message": "Invalid request format",
    "type": "invalid_request_error",
    "code": "invalid_request"
  }
}
```

Example for context window exceeded:

```json
{
  "error": {
    "message": "Context window exceeded. Input has ~25000 tokens, but the model qwen-max supports a maximum context of 10000 tokens.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "context_window_exceeded"
  }
}
```

**Causes:**

- Missing required fields
- Invalid message format
- Malformed JSON
- Context window exceeded

#### 401 Unauthorized

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

**Causes:**

- Missing API key
- Invalid API key

#### 429 Too Many Requests

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "type": "rate_limit_error",
    "code": "rate_limit"
  }
}
```

**Causes:**

- Too many requests in short time
- Account cooldown active

**Solution:**

- Wait for cooldown period
- Implement exponential backoff

#### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```

**Causes:**

- Browser automation failure
- Qwen API error
- Session pool exhausted

## SDKs and Clients

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:26405/v1"
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### JavaScript/Node.js (OpenAI SDK)

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "http://localhost:26405/v1",
});

const stream = await client.chat.completions.create({
  model: "qwen-max",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENGATE_API_KEY,
  baseURL: "http://localhost:26405/v1",
});

async function chat(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: "qwen-max",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content || "";
}
```

### curl

```bash
# Streaming
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# Non-streaming
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## Advanced Features

### Tool Call Content Gating

OpenGate tracks tool call nesting depth during streaming (`toolCallDepth` counter). Content inside tool call XML blocks (`<function=...>`) is suppressed from client emission to prevent chunk-boundary fragments from leaking. The full clean tool call text is delivered as a single `finish_reason: tool_calls` phase.

### DeepSeek Tool-Call Emulation

See [DeepSeek Tool Calling (Emulated)](#deepseek-tool-calling-emulated) under the Chat Completions endpoint for the full pipeline. In short: tool schemas are injected with a strict JSON-array output contract appended at the end of the prompt, parallel `tool_calls` are parsed from the model's text output, and multi-turn agentic loops keep full context via XML-escaped `<tool_result>` blocks. If the output can't be parsed as JSON, the response falls back to plain text (no tool call) — the emulation is heuristic by design.

### Reasoning / Thinking

DeepSeek responses include `reasoning_content` deltas (streaming) or a `reasoning_content` field on the message (non-streaming) when `DEEPSEEK_THINKING` is enabled. Set `DEEPSEEK_THINKING=false` in config to disable.

### Upstream Error Detection

DeepSeek sometimes returns errors with HTTP 200 and a JSON body (e.g. `{"code":40301,"msg":"INVALID_POW_RESPONSE"}`). OpenGate detects these and surfaces them as proper upstream errors (408/401/429/400) so the handler can retry with a fresh Proof-of-Work solution instead of returning an empty response.

### Stream Finalization

If the upstream stream ends without a `finish_reason` (common with DeepSeek's FINISHED status patch), OpenGate synthesizes an OpenAI `finish_reason: "stop"` chunk before `[DONE]` so OpenAI-compatible clients don't treat the stream as truncated.

### Tool Compression

Tool results are intelligently compressed before being sent to the Qwen model. Git diffs, JSON arrays, and structured data are summarized to reduce token usage and improve response quality.

### Session Pooling

Sessions are automatically managed per-account using browser session contexts. The pool rotates across accounts, auto-scales under load, and cleans up idle sessions. No API-level configuration required.

## Support

For questions or issues:

- **Documentation**: [README.md](../README.md)
- **Issues**: [GitHub Issues](https://github.com/youssefvdel/opengate/issues)
- **Discussions**: [GitHub Discussions](https://github.com/youssefvdel/opengate/discussions)
