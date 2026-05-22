# Connections Map

How everything fits together.

```mermaid
graph TB
    subgraph "External"
        Client[OpenAI SDK Client]
        QwenAPI[chat.qwen.ai API]
        QwenUI[chat.qwen.ai Web UI]
    end
    
    subgraph "Proxy Server"
        Hono[Hono HTTP Server]
        Chat[chat.ts - Chat Completions]
        Mutex[Global Chat Mutex]
        Retry[Retry + Backoff]
        Delta[getIncrementalDelta]
        ErrorParse[parseQwenErrorPayload]
    end
    
    subgraph "Browser Automation"
        PW[playwright.ts]
        Browser[Playwright Browser]
        HeaderCache[Header Cache TTL 10min]
        UIMutex[UI Mutex]
        SessionCheck[checkValidSession]
        AutoLogin[Auto Login]
        Intercept[Route Interception]
    end
    
    subgraph "Qwen Integration"
        QwenService[qwen.ts]
        Models[fetchQwenModels]
        Stream[createQwenStream]
        SessionStates[sessionStates]
        DisableTools[disableNativeTools]
    end
    
    subgraph "Tool System"
        Registry[tools/registry.ts]
        Schema[tools/schema.ts]
        Executor[tools/executor.ts]
        Parser[tools/parser.ts]
        JSONFix[json.ts - robustParseJSON]
    end
    
    subgraph "State Machine (Incomplete)"
        RuntimeTypes[runtime/types.ts]
        Engine[runtime/engine.ts - 71 lines]
    end
    
    Client -->|POST /v1/chat| Hono
    Hono -->|route| Chat
    
    Chat -->|acquire| Mutex
    Chat -->|createQwenStream| QwenService
    Chat -->|delta detection| Delta
    
    QwenService -->|getQwenHeaders| PW
    QwenService -->|fetch with bx-headers| QwenAPI
    
    PW -->|navigate & intercept| Browser
    PW -->|extract| Intercept
    PW -->|cache| HeaderCache
    PW -->|protect UI| UIMutex
    PW -->|check| SessionCheck
    PW -->|credential login| AutoLogin
    Browser -->|send request| QwenUI
    
    QwenService -->|track parent| SessionStates
    QwenService -->|once| DisableTools
    QwenService -->|list| Models
    
    Chat -->|tool calls detected| Parser
    Chat -->|tool parsing| JSONFix
    Parser -->|parsed calls| Executor
    Executor -->|lookup & execute| Registry
    Registry -->|validate args| Schema
    Executor -->|loop back| Chat
    
    Chat -->|upstream errors| ErrorParse
    Chat -->|retryable failures| Retry
    Retry -->|re-call| QwenService
    
    QwenAPI -->|SSE stream| Chat
    Chat -->|OpenAI format stream| Client
    
    subgraph "Type Duplication (Problem)"
        Types1[tools/types.ts]
        Types2[utils/types.ts]
        Types3[types/openai.ts]
    end
    
    Types1 -.->|overlaps with| Types2
    Types2 -.->|overlaps with| Types3
    
    subgraph "Dead/Half Code"
        Engine -.->|incomplete| RuntimeTypes
    end
```

## Data Flow: Headers

```
Browser JavaScript
      │
      │ generates bx-ua, bx-umidtoken, bx-v
      ▼
QwenUI page
      │
      │ outgoing POST to /api/v2/chat/completions
      ▼
getQwenHeaders() intercepts
      │
      │ extracts: cookie, bx-ua, bx-umidtoken, bx-v
      │ caches for 10 minutes
      ▼
createQwenStream() uses them for fetch()
      │
      │ real API call to Qwen
      ▼
QwenAPI responds with SSE stream
```

## Data Flow: Messages

```
Client sends: [{role:"user", content:"Hello"}]
      │
      ▼
chat.ts builds prompt:
  "User: Hello\n\n"
      │
      ▼
createQwenStream() wraps in Qwen format:
  { messages: [{ fid, role:"user", content:"User: Hello...", feature_config:{...} }] }
      │
      ▼
QwenAPI streams back:
  data: {"choices":[{"delta":{"phase":"answer","content":"Hi!"}}]}
      │
      ▼
chat.ts parses → OpenAI format:
  data: {"choices":[{"delta":{"content":"Hi!"}}]}
```

## Data Flow: Tool Calls

```
Qwen outputs:
  <tool_call>
  {"name": "read_file", "arguments": {"path": "hello.txt"}}
  </tool_call>
      │
      ▼
StreamingToolParser.feed() parses tags
      │
      ▼
ToolCall[] → executed via registry.execute()
      │
      ▼
Results appended as "Tool Response" message
      │
      ▼
Sent back to Qwen as continuation of conversation
```

## Constraint Chain

```
Qwen single-session limit
      │
      ▼
Global Mutex serializes requests
      │
      ▼
If another request arrives → it waits or retries
      │
      ▼
If "in progress" error passes through → retry with backoff
      │
      ▼
If all retries fail → error returned to client
```

## The Fragility Chain

```
Qwen UI changes send button class
      │
      ▼
Route interception fails
      │
      ▼
Can't extract bx-headers
      │
      ▼
Can't call Qwen API
      │
      ▼
Proxy is broken
```

The fix: current Enter key fallback bypasses the button entirely. But if Qwen changes Enter behavior too, it breaks.
