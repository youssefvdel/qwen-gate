# Qwen UI Reverse Engineering

## Current Page Structure (Authenticated, 2026-05-22)

### Chat Page (After Login)

```
┌──────────────────────────────────────────────────┐
│ [☰] [Search Chats...]                   [?] [Y] │
│ ┌──────────────────┐                             │
│ │ chat-item 1       │   ┌────────────────────────┤
│ │ chat-item 2       │   │  Conversation thread   │
│ │ chat-item 3       │   │                        │
│ │ ...               │   │                        │
│ └──────────────────┘   │                        │
│                         │                        │
│  ┌──────────────────────────────────────────┐    │
│  │ [Model▾ Qwen3.6-Plus]  [Thinking▾ Auto]  │    │
│  │ ┌──────────────────────────────────┐ [➚] │    │
│  │ │ textarea.message-input-textarea  │ send │    │
│  │ │ How can I help you today?        │      │    │
│  │ └──────────────────────────────────┘      │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### Input Area Hierarchy

```html
div.message-input-container-area
  div.mode-select
    span.ant-dropdown-trigger
      div.mode-select-open
        ... model selection
  div#notification_update_popover_model_selector
  div.message-input-right-button
    div.qwen-thinking-selector              ← "Auto" thinking mode
    div.message-input-right-button-send
      div.chat-prompt-send-button           ← click target
        button.send-button                  ← all 3 code selectors find this
          span.anticon.icon-send
            svg > use[href="#icon-line-arrow-up"]
```

### Key Elements (Authenticated)

| Role | CSS Selector | Notes |
|---|---|---|
| Textarea | `textarea.message-input-textarea` | Single row, expands |
| Send button (outer) | `div.message-input-right-button-send` | Container |
| Send button (clickable) | `div.chat-prompt-send-button` | Shows/hides based on text |
| Send button (inner) | `button.send-button` | Contains arrow-up icon |
| Send icon | `span.anticon.icon-send` | Arrow-up SVG |
| Model selector | `div.index-module__model-selector___rdCim` | Shows "Qwen3.6-Plus" |
| Thinking selector | `div.qwen-thinking-selector` | Ant Select, shows "Auto" |
| Voice input | `span.microphone-icon` | Replaced by send when text entered |

### Unauthenticated vs Authenticated Difference

**Unauthenticated landing page** has a completely different structure — no send button exists because you can't send messages without logging in. Instead: textarea + "Get Started" CTA + Log in/Sign up buttons.

**Authenticated page** has the full chat interface with `message-input-right-button-send > chat-prompt-send-button > button.send-button`.

## What the Playwright Code Selectors Hit

```typescript
// ALL 3 selectors WORK on the authenticated page:
'.message-input-right-button-send .send-button'  // → button.send-button ✓
'.chat-prompt-send-button'                        // → div directly ✓
'button.send-button'                               // → button directly ✓
```

**Correction from earlier analysis**: The selectors are NOT broken. They work correctly on the authenticated page. I was testing on the unauthenticated page where the DOM structure is different.

## API Endpoints (Authenticated)

When sending a message, these requests fire:

| Endpoint | Purpose |
|---|---|
| `POST /api/v2/chats/new` | Create new chat session |
| `POST /api/v2/chat/completions?chat_id=` | Main generation (SSE) |
| `POST /api/v2/users/status` | Heartbeat/status |
| `GET /api/v2/notifications/latest` | Notification check |
| `GET /api/v2/chats/?page=1` | Load chat history |

### Chat Completions Request

```http
POST https://chat.qwen.ai/api/v2/chat/completions?chat_id=621d38c8-...
```

See `003 - Reverse Engineered Qwen API.md` for full payload/response format.

### Cookies Set (Authenticated)

| Cookie | Domain | Type | Use |
|---|---|---|---|
| `token` | `.qwen.ai` | JWT (214 chars) | Auth — expires ~2.5 months |
| `cna` | `.qwen.ai` | Session ID | Cross-domain auth |
| `cnaui` | `.qwen.ai` | UUID | User identifier |
| `isg` | `.qwen.ai` | Anti-bot | Bot detection |
| `tfstk` | `.qwen.ai` | Anti-bot | Alibaba security |
| `ssxmod_itna*` | `.qwen.ai` | Anti-bot | Fingerprinting |
| `x-ap` | `chat.qwen.ai` | Region | `eu-central-1` |
| `qwen-locale` | `chat.qwen.ai` | Locale | `en-US` |
| `qwen-theme` | `chat.qwen.ai` | Theme | `dark` |
