# Request Lifecycle: From OpenAI SDK to Qwen Response

## Step-by-Step Flow

```
Client                        QwenProxy                           Qwen Backend
  │                              │                                    │
  │  POST /v1/chat/completions   │                                    │
  │  {model, messages, tools}    │                                    │
  │──────────────────────────────┤                                    │
  │                              │                                    │
  │                              │  Parse request body                │
  │                              │  Build prompt from messages        │
  │                              │  Inject tool definitions into      │
  │                              │    system prompt                   │
  │                              │                                    │
  │                              │  Acquire global chat mutex         │
  │                              │                                    │
  │                              │  ┌──────────────────────────┐      │
  │                              │  │  getQwenHeaders()        │      │
  │                              │  │  → Browser interaction   │      │
  │                              │  │  → Intercept + extract   │      │
  │                              │  │  → Return bx-ua, bx-v,  │      │
  │                              │  │    cookies, session ID   │      │
  │                              │  └──────────────────────────┘      │
  │                              │                                    │
  │                              │  POST /api/v2/chat/completions     │
  │                              │  {stream, model, parent_id,        │
  │                              │   messages[{fid, content,          │
  │                              │     feature_config}]}              │
  │                              │────────────────────────────────────┤
  │                              │  bx-ua: ...                        │
  │                              │  bx-umidtoken: ...                 │
  │                              │  bx-v: 2.5.36                     │
  │                              │  cookie: ...                       │
  │                              │                                    │
  │                              │  SSE stream:                       │
  │                              │  data: {"choices":[{               │
  │                              │    "delta":{"phase":"thinking",    │
  │                              │    "extra":{"summary_thought":{...}}│
  │                              │  }}]}                              │
  │                              │  data: {"choices":[{               │
  │                              │    "delta":{"phase":"answer",      │
  │                              │    "content":"Hello world"}}]}     │
  │                              │◄───────────────────────────────────┤
  │                              │                                    │
  │  SSE stream (OpenAI format): │                                    │
  │  data: {"choices":[{         │                                    │
  │    "delta":{"role":"assistant","content":""}}]}                   │
  │  data: {"choices":[{         │                                    │
  │    "delta":{"reasoning_content":"I'm thinking..."}}]}             │
  │  data: {"choices":[{         │                                    │
  │    "delta":{"content":"Hello"}}]}                                 │
  │◄─────────────────────────────┤                                    │
```

## Prompt Building Details

The proxy assembles a single text prompt from the OpenAI message array:

```typescript
// System messages → prepended
User: What is 2+2?

Assistant: <think>
Let me calculate this.
</think>
4

Tool Response (calculator): {"result": 4}
```

### Tool Injection
When `tools` are provided in the request, they're serialized into the system prompt:

```
# TOOLS AVAILABLE
You have access to the following tools:
[
  {
    "name": "calculator",
    "description": "Performs arithmetic",
    "parameters": { "type": "object", ... }
  }
]

# TOOL CALLING FORMAT
To use a tool, output:
<tool_call>
{"name": "calculator", "arguments": {"expr": "2+2"}}
</tool_call>
```

### Session Tracking
```typescript
const sessionStates: Record<string, string | null> = {};
// Maps chat_session_id → parent_message_id
// Stored on globalThis to survive hot-reloads
```

Each response from Qwen includes a `response.created.response_id`. The proxy stores this and sends it as `parent_id` on the next request, creating a conversation thread.

## Retry Logic

```typescript
let retries = 5;
let retryDelay = 1000;
while (retries > 0) {
  try {
    result = await createQwenStream(...);
    break;
  } catch (err) {
    retries--;
    if (isRetryable(err)) {
      // Wait and retry with exponential backoff (max 10s)
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    } else {
      throw err; // Non-retryable: bubble up
    }
  }
}
```

Retryable errors:
- "The chat is in progress!" (RateLimited upstream)
- "chat is in progress" (network-level)
- "not exist" (session expired)
- `RetryableQwenStreamError` with custom `retryAfterMs`

## Streaming vs Non-Streaming

Both paths use the same Qwen SSE stream but produce different output:

| Path | Read Full Stream | Output Format |
|---|---|---|
| `stream: false` | Buffer all chunks, accumulate content + tools | Single JSON response with `choices[0].message` |
| `stream: true` | Forward chunks as SSE events | Multiple `data: {...}` events |

**The SSE parsing loop is duplicated** between both paths (~200 lines each). The delta detection (`getIncrementalDelta`) runs in both.
