# DeepSeek Reverse Engineering

Reverse-engineered API, security, and flow documentation for [chat.deepseek.com](https://chat.deepseek.com).

## Files

| File | Description |
|------|-------------|
| [API.md](./API.md) | Endpoint reference — auth, settings, PoW, chat completions, sessions, files. |
| [SECURITY.md](./SECURITY.md) | Auth, PoW anti-DoS, AWS infrastructure, cookies, client fingerprinting analysis. |
| [AUTH.md](./AUTH.md) | Login flow — email/password auto-fill, API, session persistence. |

## Key Takeaway

DeepSeek runs on **AWS CloudFront** with a custom **Proof of Work** anti-DoS system (`DeepSeekHashV1` in SHA3 WASM) required before every chat completion. No CAPTCHA needed — PoW replaces it. Uses opaque bearer tokens (not JWT). Telemetry via ByteDance Volces APM. Backend models include Instant, Expert, and Vision modes with DeepThink (R1 reasoning) and web search toggles.

## Gateway Integration (OpenGate)

The OpenGate gateway consumes this API in `src/routes/providers/deepseek/`. Key integration notes (verified live 2026-08):

- **No native function calling**: `chat/completion` accepts a `tools` field but silently ignores it — the model answers in plain text. OpenGate **emulates** tool calling (`toolEmulation.ts`) by appending a strict JSON-array output contract at the **end** of the prompt and parsing the model's text output into OpenAI `tool_calls`. Parallel calls are supported (Hermes-style agents).
- **Model selection is by `model_type`**, not model ID: the remote feature store (`model_configs`) exposes exactly `default` ("Instant"), `expert` ("Expert"), and `vision` ("Vision"). Gateway aliases (`deepseek-chat` / `deepseek-reasoner` / `deepseek-vl2` / `deepseek-v4-flash` / `deepseek-v4-pro`) are mapped in `pipeline.ts`.
- **PoW solutions are single-use**: each solved header is accepted exactly once — reusing one returns `40301 INVALID_POW_RESPONSE`. OpenGate solves fresh per request (`pow.ts`) and retries on that error.
- **Errors can arrive with HTTP 200**: DeepSeek returns JSON error bodies like `{"code":40301,"msg":"INVALID_POW_RESPONSE"}` with status 200. `pipeline.ts` detects these and surfaces them as retryable upstream errors.
- **Streams may omit `finish_reason`**: the FINISHED status patch sometimes arrives without a finish chunk — OpenGate synthesizes an OpenAI `finish_reason` chunk before `[DONE]`.
- **Search**: declaring a `web_search`-style tool enables `search_enabled: true` on the chat request (this is how chat.deepseek.com models "search the web" in the web UI).

## API Surface

```
POST /api/v0/chat/completion          # Core LLM. Needs PoW solved.
POST /api/v0/chat/create_pow_challenge # Get PoW challenge.
POST /api/v0/chat_session/create      # New session.
GET  /api/v0/chat_session/fetch_page  # List sessions.
GET  /api/v0/users/current            # User profile.
GET  /api/v0/client/settings          # Config (main, model, web_upgrade, banner).
POST /api/v0/file/upload_file         # File upload. Needs PoW.
```

## Differences from z.ai

| Aspect | z.ai | DeepSeek |
|--------|------|----------|
| Anti-abuse | Aliyun CAPTCHA puzzle | Proof of Work (SHA3 hash) |
| Auth | ES256 JWT (3 delivery channels) | Opaque Bearer token |
| Hosting | Alibaba Cloud ESA | AWS CloudFront + ELB |
| Streaming | SSE | SSE (custom protocol) |
| Model | GLM-5.2 / GLM-4.7 | DeepSeek (Instant/Expert/Vision) |
| Telemetry | Google Analytics | ByteDance Volces APM |
| Endpoint URL | `/api/v2/chat/completions` | `/api/v0/chat/completion` |
