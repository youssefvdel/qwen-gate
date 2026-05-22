# Open Questions

Things I don't know that would change the improvement priorities.

## 1. What Breaks in Practice?

- How often does header extraction fail? (The browser dance is the weakest link)
- How often does the "chat in progress" Mutex cause timeouts for real users?
- Which models actually work? Does `qwen3.7-max` have the same API?
- Does the `-no-thinking` variant actually disable thinking?

## 2. How Many Users?

- Single user (personal proxy) → current design is fine
- 2-5 users → Mutex becomes a bottleneck, multi-session needed
- 10+ users → Need multiple browser profiles + session pool

## 3. How Long Does a Session Last?

- Hours? (cookies work until browser close)
- Days? (qwen_profile/ persists across restarts)
- Weeks? (auth tokens might expire)

## 4. What's the Actual Error Rate?

Without observability, hard to know which component fails most:
- Browser header interception timeout?
- Qwen API "in progress" errors?
- Rate limiting (daily quota)?
- Session expiry?
- Network errors?

## 5. Who's the User?

- Developer running locally for AI-assisted coding? → reliability + simple setup matter
- Production service behind an API? → concurrent users, monitoring, uptime matter
- Yourself experimenting? → whatever's fun to build

## 6. What Would You Add?

- Image/vision support? (Qwen likely supports it)
- File uploads? (the API has a `files` field)
- Voice? (probably not through this API)
- Web search integration? (Qwen has `auto_search` in feature_config)

## 7. Why the Half-Built Runtime Engine?

The types in `runtime/types.ts` are genuinely well-designed:
- Agent lifecycle phases
- Event system with timestamps
- LLM adapter interface (supports both streaming and non-streaming)
- Tool policies (rate limiting, approval)

But `runtime/engine.ts` is only 71 lines — it creates initial state and then... nothing.

Was this:
- A planned refactor that never happened?
- A migration from a different pattern?
- A proof of concept for a larger architecture?

## 8. The `types/openai.ts` vs `utils/types.ts` Mystery

`utils/types.ts` has these types that `types/openai.ts` doesn't:
- `stream_options?: { include_usage?: boolean }`

`types/openai.ts` has these that `utils/types.ts` doesn't:
- `ToolPolicy` (maxCallsPerRun, requiresApproval, rateLimit, allowedContexts)
- Full agent runtime types (indirectly via imports)

Which one is "current"? The chat handler uses `utils/types.ts`. The future (runtime engine) uses `types/openai.ts`.
