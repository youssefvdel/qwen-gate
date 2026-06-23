# Qwen Gate Architecture

Technical architecture and design documentation for Qwen Gate.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Key Subsystems](#key-subsystems)
  - [Session Pool](#session-pool)
  - [Content Filtering & Streaming](#content-filtering--streaming)
- [Technology Stack](#technology-stack)
- [Design Decisions](#design-decisions)
- [Scalability](#scalability)
- [Security Architecture](#security-architecture)

## Overview

Qwen Gate is an OpenAI-compatible API proxy that provides access to Qwen AI models through intelligent browser automation. It bridges the gap between Qwen's web interface and standard AI API clients by:

1. **Automating browser interactions** with Qwen's chat interface
2. **Managing multiple accounts** with automatic rotation and session pooling
3. **Providing OpenAI-compatible endpoints** for seamless integration
4. **Optimizing responses** with content filtering and streaming sanitization
5. **Monitoring and debugging** through a real-time dashboard

### Core Principles

- **Transparency**: OpenAI-compatible API that works with existing clients
- **Reliability**: Multi-account rotation and automatic failover
- **Efficiency**: Content filtering and intelligent caching
- **Observability**: Real-time monitoring and comprehensive logging
- **Safety**: Echo detection and content filtering

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Clients                          │
│  (OpenAI SDK, curl, custom apps, LangChain, etc.)           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ OpenAI-compatible API
                 │ POST /v1/chat/completions
                 │ GET /v1/models
                 │
┌────────────────▼───────────────────────────────────────────┐
│                     Qwen Gate Server                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              API Layer (Hono)                        │  │
│  │  - Request validation                                │  │
│  │  - Authentication                                    │  │
│  │  - Rate limiting                                     │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
│  │           Session Pool Manager                       │  │
│  │  - Account rotation                                  │  │
│  │  - Session lifecycle                                 │  │
│  │  - Health monitoring                                 │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
 │  │        Qwen API Transport Layer                       │  │
 │  │  - Browserless Node.js fetch via wreq-js             │  │
 │  │  - File upload handling                              │  │
 │  │  - bx-ua header generation                           │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
│  ┌────────────────▼─────────────────────────────────────┐  │
│  │           Response Pipeline                          │  │
│  │  - Echo detection & filtering                        │  │
│  │  - Content filtering                                  │  │
│  │  - OpenAI format conversion                          │  │
│  └────────────────┬─────────────────────────────────────┘  │
│                   │                                        │
└───────────────────┼────────────────────────────────────────┘
                    │
                    │ Streaming/Non-streaming response
                    │
┌───────────────────▼─────────────────────────────────────────┐
│                      API Clients                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                Dashboard (Vanilla HTML/JS)                   │
│  - Real-time monitoring                                     │
│  - Account management                                       │
│  - Configuration UI                                         │
│  - Request logs                                             │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. API Layer (Hono)

**Location**: `src/routes/`

The API layer handles all HTTP requests and provides OpenAI-compatible endpoints.

**Components**:

- `chat.ts` - Chat completion endpoint handler
- `chatStreaming.ts` - Streaming response logic
- `chatHelpers.ts` - Request/response utilities
- `accounts.ts` - Account management endpoints

**Responsibilities**:

- Request validation and parsing
- Authentication (API key verification)
- Rate limiting
- Response formatting (OpenAI format)
- Error handling

### 2. Session Pool Manager

**Location**: `src/services/sessionPool.ts`

Manages browser sessions and Qwen account rotation.

**Responsibilities**:

- Session lifecycle management (create, reuse, destroy)
- Account rotation and load balancing
- Session health monitoring
- Rate limit tracking and cooldown
- Session pooling for performance

**Key Classes**:

- `SessionPool` - Main pool manager
- `Session` - Individual browser session
- `AccountManager` - Account state tracking

### 3. Qwen API Transport

**Location**: `src/services/` (browserlessFetch.ts, qwen.ts, playwright.ts)

Dual transport — Node.js fetch via wreq-js for API calls, Playwright only for login/auth/header bootstrap.

**Responsibilities**:

- Pure Node.js HTTP requests to Qwen API via wreq-js session
- wreq-js provides TLS fingerprinting for bot detection evasion
- bx-ua generator creates realistic browser UA headers without Playwright
- Playwright still used for login authentication and initial header extraction
- File upload handling via qwenFileUpload.ts for large context

**Key Functions**:

- `browserlessFetch()` - Make Qwen API calls via wreq-js
- `getQwenHeaders()` - Auth headers (from Playwright bootstrap)
- `fetchQwenModels()` - Model list
- `closeAll()` - Cleanup sessions

The routes layer handles request dispatch, streaming coordination, content cleanup, and dashboard serving. Route files live directly in `src/routes/` — there is no subdirectory per filter.

### 4. Configuration Service

**Location**: `src/services/configService.ts`

Centralized configuration management with three-tier priority.

**Priority Order**:

1. Environment variables (highest)
2. config.json (persistent)
3. Default values (fallback)

**Features**:

- Runtime configuration updates
- Web UI integration
- Type-safe configuration access
- Hot reload support

### 5. Dashboard (Frontend)

**Location**: `src/routes/dashboard/`

The dashboard consists of a routing hub (`dashboardRoutes.ts`), a monitoring page (`monitor.ts`), a sidebar component (`sidebar.ts`), and a `public/` directory with approximately 15 static assets (vanilla HTML/JS/CSS/SVG). Together they provide overview monitoring, request logs, account management, network debugging, and settings pages.

## Data Flow

### Chat Completion Flow

```
1. Client Request
   POST /v1/chat/completions
   {
     "model": "qwen-max",
     "messages": [...],
     "stream": true
   }
   │
   ▼
2. API Layer
   - Validate request
   - Check API key
   - Parse messages
   │
   ▼
3. Session Pool
   - Select available account
   - Get/create browser session
   - Check rate limits
   │
   ▼
4. Qwen API Transport
   - Send HTTP request via wreq-js session
   - Handle file upload if context large
   - Stream response chunks
    │
    ▼
5. Response Extraction
   - Parse Qwen response
   - Extract text content
   - Detect tool calls
    │
    ▼
6. Response Pipeline
   - Content filtering
   - Format to OpenAI schema
   │
   ▼
7. Streaming Response
   - Send SSE chunks
   - Handle tool calls
   - Complete with [DONE]
   │
   ▼
8. Client Receives
   data: {"choices": [{"delta": {"content": "..."}}]}
   data: [DONE]
```

### Tool Calling Flow

```
1. Client Request with Tools
   {
     "messages": [...],
     "tools": [{"type": "function", ...}]
   }
   │
   ▼
2. Qwen Processes Request
   - Analyzes available tools
   - Decides to call tool
   - Returns tool_call
   │
   ▼
3. Response Pipeline
   - Detects tool_call in response
   - Formats as OpenAI tool_call
   - Returns to client
   │
   ▼
4. Client Executes Tool
   - Runs function locally
   - Gets result
   │
   ▼
5. Client Sends Tool Result
   {
     "messages": [
       {...user message...},
       {...assistant tool_call...},
       {"role": "tool", "content": "result"}
     ]
   }
   │
   ▼
6. Qwen Continues
   - Processes tool result
   - Generates final response
   │
    ▼
```

## Key Subsystems

### Session Pool

**Purpose**: Efficiently manage multiple browser sessions across Qwen accounts.

**Architecture**:

```
SessionPool
├── AccountManager
│   ├── Account 1 (active, 5 sessions)
│   ├── Account 2 (active, 3 sessions)
│   └── Account 3 (cooldown, 0 sessions)
├── SessionCache
│   ├── Session A (idle, ready)
│   ├── Session B (active, in-use)
│   └── Session C (idle, ready)
└── HealthMonitor
    ├── Rate limit tracking
    ├── Error rate monitoring
    └── Session validation
```

**Session Lifecycle**:

1. **Create**: Launch browser, authenticate with Qwen
2. **Use**: Send messages, extract responses
3. **Idle**: Keep alive for reuse
4. **Recycle**: Refresh authentication
5. **Destroy**: Close browser, cleanup resources

**Load Balancing**:

- Round-robin across active accounts
- Weighted by account health
- Automatic failover on errors
- Rate limit awareness

### Content Filtering & Streaming

**Purpose**: Real-time content sanitization during streaming — think tag extraction, XML artifact removal, and tool call content gating.

**Pipeline Order**: `cleanTextOfXmlArtifacts → filterContent → cleanThinkTags`

```
SSE Chunk Arrives
         │
         ▼
┌────────────────────────────┐
│ cleanThinkTags (per-chunk) │ Strip only complete think/function tags
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│ extractDeltaContent        │ Extract text delta from SSE response
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│ detectCumulativeChunk      │ Handle overlapping/cumulative chunks
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐
│ getSnapshotDelta           │ Compute incremental text diff
└──────────┬─────────────────┘
           │
           ▼
     Client Stream (SSE)

Flush Path (full pipeline):
┌──────────────────────────────┐
│ cleanTextOfXmlArtifacts      │ Strip all XML tool call syntax
├──────────────────────────────┤
│ filterContent                │ Segment-based think extraction
├──────────────────────────────┤
│ cleanThinkTags               │ Final pass for remaining tags
└──────────────────────────────┘
```

**Components**:

- **`src/utils/contentFilter.ts`** (116 lines): `filterContent()` performs segment-based think tag extraction and XML artifact cleaning. Uses `thinkTagStripper.ts` and `xmlStripper.ts`.

- **`src/routes/chatStreamingHelpers.ts`** (387 lines): Per-chunk processing pipeline. `filterContentPipeline()` orchestrates the full pipeline order. `processStreamData()` handles each SSE chunk — delta extraction, cumulative detection, tool call parsing via `parseXmlToolCalls`, and content gating via `toolCallDepth`.

- **`src/routes/streamLoop.ts`** (230 lines): Main streaming loop (`runStreamLoop()`) with idle timeout (default 45s, configurable via `STREAM_IDLE_TIMEOUT_MS`). `handlePostStreamCompletion()` runs the full flush pipeline with amplification guard.

- **`src/routes/chatHelpers.ts`** (304 lines): Aggregation layer re-exporting from `chatHelpersCore.ts`. Provides `createQwenStream`, `buildFeatureConfig`, model routing, tool call handling, and user content sanitization.

**Tool Call Depth Gating**: The `toolCallDepth` counter in `StreamProcessingState` tracks nesting of XML tool call blocks (`<function=...>`). When inside a tool call (`depth > 0`), content emission is suppressed to prevent chunk-boundary fragments from leaking to the client. The flush path handles the clean version of the full tool call text.

**Idle Timeout**: `runStreamLoop()` races `reader.read()` against a `setTimeout`. If no data arrives within the window, the stream is cancelled with an error message.

**Amplification Guard**: Both the per-chunk path (`writeContentDelta`) and flush path (`handlePostStreamCompletion`) check `checkAmplificationGuard()` to detect runaway output loops. `checkFinalAmplification()` runs after stream completion for final validation.

## Technology Stack

### Backend

| Technology     | Purpose              | Version |
| -------------- | -------------------- | ------- |
| **Bun**        | Runtime              | 1.3+    |
| **TypeScript** | Type safety          | 5.7+    |
| **Hono**       | Web framework        | Latest  |
| **wreq-js** | Node.js HTTP with TLS fingerprinting | Latest  |
| **Playwright** | Login/auth only (not for API) | Latest  |
| **tsx**        | TypeScript execution | Latest  |

### Frontend

| Technology       | Purpose                   | Notes                 |
| ---------------- | ------------------------- | --------------------- |
| **Vanilla HTML** | Page structure            | Template literals     |
| **Vanilla CSS**  | Styling                   | Claymorphism design   |
| **Vanilla JS**   | Interactivity             | SSE, DOM manipulation |

### Why These Choices?

**Hono**:

- Lightweight and fast
- OpenAI-compatible API design
- Excellent TypeScript support
- Built-in streaming support

**wreq-js**:

- Lightweight Node.js HTTP client using Rust-native TLS via napi-rs
- Provides TLS fingerprinting that mimics browser TLS handshakes
- Per-request sessions to avoid tokio epoll/Bun event loop conflicts
- Dramatically lower overhead than Playwright for API calls

**TypeScript**:

- Type safety
- Better IDE support
- Catch errors at compile time
- Self-documenting code

## Design Decisions

### 1. Dual Transport: Browserless API + Playwright Auth

**Decision**: Use pure Node.js HTTP via wreq-js for API requests. Playwright is used only for login/authentication.

**Rationale**:

- Qwen doesn't provide a public API
- Earlier approach used full browser automation for everything, but wreq-js provides TLS fingerprinting that avoids bot detection while being much lighter
- Browser is only needed for login cookies

**Tradeoffs**:

- Lower resource usage than full browser automation
- No browser overhead for requests
- Still need Playwright for auth bootstrap
- wreq-js sessions must be disposed carefully (tokio epoll fd management)

### 2. Multi-Account Rotation

**Decision**: Support multiple Qwen accounts with automatic rotation.

**Rationale**:

- Bypass per-account rate limits
- Increase overall throughput
- Provide failover on errors
- Load balance across accounts

**Tradeoffs**:

- Requires managing multiple accounts
- More complex session management
- Need to track account health
- Potential for account conflicts

### 3. Configuration System

**Decision**: Three-tier configuration (env → config.json → defaults).

**Rationale**:

- Flexibility for different deployments
- Runtime configuration changes
- Persistent settings across restarts
- Sensible defaults for quick start

**Tradeoffs**:

- More complex than single source
- Need to document priority
- Potential for confusion
- Requires validation logic

## Scalability

### Horizontal Scaling

**Strategy**: Run multiple Qwen Gate instances behind a load balancer.

```
Load Balancer (nginx)
    │
    ├─► Qwen Gate Instance 1
    │
    ├─► Qwen Gate Instance 2
    │
    └─► Qwen Gate Instance 3


**Considerations**:

- Session affinity for stateful requests
- Shared configuration (Redis or database)
- Distributed rate limiting
- Health checks and failover

### Vertical Scaling

**Strategy**: Increase resources on a single instance.

**Optimizations**:

- Increase session pool size
- Add more CPU cores
- Increase memory for browser instances
- Use faster storage for logs

**Limits**:

- Browser instances are CPU-intensive
- Memory usage grows with sessions
- Single point of failure
- Network bandwidth limits

### Performance Characteristics

| Metric              | Single Instance | Scaled (3 instances) |
| ------------------- | --------------- | -------------------- |
| Concurrent requests | 50-100          | 150-300              |
| Requests/second     | 10-20           | 30-60                |
| Average latency     | 2-5s            | 2-5s                 |
| Memory usage        | 2-4 GB          | 6-12 GB              |
| CPU usage           | 2-4 cores       | 6-12 cores           |

## Security Architecture

### Authentication

```

Client Request
│
▼
┌─────────────────┐
│ API Key Check   │ Verify Authorization header
└────────┬────────┘
│
▼
┌─────────────────┐
│ Rate Limiter    │ Check request rate
└────────┬────────┘
│
▼
┌─────────────────┐
│ Request Handler │ Process request
└─────────────────┘

```

**API Key Management**:

- Stored in environment or config.json
- 32+ character random keys recommended
- Supports multiple keys for different clients
- Can be disabled for development

### Browser Isolation

**Strategy**: Each session runs in an isolated browser context.

```

Browser Instance
├─► Context 1 (Session A)
│ ├─► Isolated cookies
│ ├─► Isolated storage
│ └─► Isolated cache
│
├─► Context 2 (Session B)
│ ├─► Isolated cookies
│ ├─► Isolated storage
│ └─► Isolated cache
│
└─► Context 3 (Session C)
├─► Isolated cookies
├─► Isolated storage
└─► Isolated cache

````

**Benefits**:

- Prevents cross-session contamination
- Isolates authentication state
- Reduces security risks
- Simplifies cleanup

### Data Protection

**Sensitive Data Handling**:

1. **API Keys**: Never logged or stored in responses
2. **Credentials**: Stored securely, not exposed to clients
3. **Logs**: Sanitized before storage
4. **Memory**: Cleared after use

**Content Filtering**:

- Removes sensitive patterns from responses
- Filters credentials and tokens
- Sanitizes personal information
- Configurable filter rules

### Network Security

**Recommendations**:

1. Use HTTPS in production
2. Place behind reverse proxy
3. Enable firewall rules
4. Use VPN for admin access
5. Regular security updates

**Deployment Security**:

```nginx
# Rate limiting
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

# Security headers
add_header X-Content-Type-Options "nosniff";
add_header X-Frame-Options "SAMEORIGIN";
add_header Strict-Transport-Security "max-age=31536000";

# CORS (if needed)
add_header Access-Control-Allow-Origin "https://yourdomain.com";
````

## Monitoring and Observability

### Metrics

**Application Metrics**:

- Request count and rate
- Response latency (p50, p95, p99)
- Error rate by type
- Session pool utilization
- Account health status

**System Metrics**:

- CPU usage per instance
- Memory usage per session
- Network I/O
- Browser instance count

### Logging

**Log Levels**:

- `error`: Critical failures
- `warn`: Recoverable issues
- `info`: Normal operations
- `debug`: Detailed debugging

**Log Structure**:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "component": "session-pool",
  "message": "Session created",
  "data": {
    "sessionId": "abc123",
    "account": "user@example.com",
    "latency": 1234
  }
}
```

### Dashboard Integration

The dashboard provides:

- Real-time request logs
- Session pool status
- Account health overview
- Error tracking
- Performance metrics

## Future Considerations

### Planned Enhancements

1. **Caching Layer**: Cache frequent queries to reduce load
2. **WebSocket Support**: Real-time bidirectional communication
3. **Plugin System**: Extensible middleware and filters
4. **Multi-Model Support**: Support for other AI providers
5. **Advanced Analytics**: Usage patterns and optimization insights

### Architectural Evolution

**Short-term**:

- Improve session reuse
- Optimize browser resource usage
- Improve content filtering strategies

**Long-term**:

- Distributed session storage
- Advanced content filtering strategies
- Automatic performance tuning
- Multi-region deployment

## Conclusion

Qwen Gate's architecture balances performance, reliability, and maintainability. The multi-layer design provides clear separation of concerns, while the plugin-based pipeline allows for easy extension. The focus on observability and monitoring ensures operational excellence in production environments.

For implementation details, see:

- [API Reference](API.md)
- [Deployment Guide](DEPLOYMENT.md)
- [Contributing Guide](../CONTRIBUTING.md)
