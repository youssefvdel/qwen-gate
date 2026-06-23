# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:alpine AS build
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY . .
RUN bun run build

# ── Production stage ────────────────────────────────────────────────
FROM oven/bun:alpine AS production
WORKDIR /app

# Install system deps for Playwright/Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    glib \
    font-noto-cjk \
    dbus \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Non-root user for security
RUN addgroup -g 1001 -S qwen && \
    adduser -S qwen -u 1001 -G qwen && \
    mkdir -p /app/.qwen /app/logs && \
    chown -R qwen:qwen /app
USER qwen

ENV QWEN_GATE_PORT=26405
ENV NODE_ENV=production
EXPOSE 26405
VOLUME [ "/app/.qwen" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:26405/v1/models || exit 1

CMD [ "bun", "dist/index.js" ]
