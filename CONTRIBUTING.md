# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `bun install`
4. Create a branch: `git checkout -b feat/my-feature`

## Development

```bash
bun dev        # Start in development mode
bun test            # Run tests
```

### Code Style

- TypeScript with strict mode
- Use `logStore.systemLog()` for logging — not `console.*`
- Follow existing patterns in the codebase
- Keep functions focused and under 80 lines where possible

## Pull Request Process

1. Update tests to cover your changes
2. Run `bun test` — all tests must pass
3. Update relevant documentation in `docs/` if needed
4. Add a CHANGELOG entry

## Commit Messages

Conventional Commits format:

```
feat(scopes): add new feature
fix(scopes): fix a bug
chore(scopes): maintenance task
docs(scopes): documentation changes
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point
├── cluster.ts      # Cluster mode
├── index.tsx       # Server entry, routing, CORS, auth
├── models.json     # Model definitions
├── middleware/      # Rate limiter
├── routes/         # API handlers + streaming
│   └── dashboard/  # Web dashboard
├── services/       # Auth, accounts, sessions, Qwen API transport, config
├── tests/          # Integration tests
├── tools/          # Tool calling system
├── types/          # OpenAI-compatible types
└── utils/          # Shared utilities
```

## Questions?

Open a GitHub Discussion or issue.
