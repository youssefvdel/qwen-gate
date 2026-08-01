# OpenGate Deployment Guide

Production deployment for OpenGate.

## Table of Contents

- [Quick Start](#quick-start)
- [PM2 Process Manager](#pm2-process-manager)
- [systemd Service (Linux)](#systemd-service-linux)
- [Configuration](#configuration)
- [Reverse Proxy (nginx)](#reverse-proxy-nginx)
- [Monitoring](#monitoring)
- [Security](#security)

## Quick Start

```bash
# Install dependencies (postinstall creates config.json with defaults)
bun install --production

# Customize config (optional -- skip if defaults are fine)
bun run setup

# Start the server
bun start
```

The server runs on `http://localhost:26405` by default. Configure via `bun run setup` or edit `config.json` directly.

## PM2 Process Manager

PM2 keeps the server running forever with auto-restart on crash.

```bash
# Install PM2 globally
bun add -g pm2

# Start with PM2
pm2 start bun --name "opengate" -- start

# Save process list (survives reboot)
pm2 save

# Generate startup script
pm2 startup

# Useful commands
pm2 status                # View status
pm2 logs opengate        # View logs
pm2 monit                 # Monitor resources
pm2 restart opengate     # Restart
pm2 stop opengate        # Stop
```

### Clustering (multi-core)

```bash
pm2 start bun --name "opengate" -i max -- start
```

Runs one instance per CPU core.

### Auto-restart on crash

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'opengate',
    script: 'bun',
    args: 'start',
    instances: 1,
    exec_mode: 'fork',
    max_restarts: 10,
    restart_delay: 4000,
    max_memory_restart: '1G',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
  }]
};

// mkdir -p logs  (create the logs directory referenced above)
// pm2 start ecosystem.config.js
```

## systemd Service (Linux)

Create `/etc/systemd/system/opengate.service`:

```ini
[Unit]
Description=OpenGate API Proxy
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/opengate
ExecStart=/usr/bin/bun start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable opengate
sudo systemctl start opengate
sudo systemctl status opengate
journalctl -u opengate -f  # View logs
```

## Configuration

Configuration lives in `config.json` at the project root. There is no `.env` file — all settings use `config.json`.

### Interactive Setup

```bash
bun run setup
```

Prompts for port, host, API key, browser engine, and more. Saves to `config.json`.

### Manual Configuration

```json
{
  "PORT": "26405",
  "HOST": "0.0.0.0",
  "API_KEY": "your-secret-key",
  "BROWSER": "chromium",
  "TOOL_CALLING": "true",
  "CLEAN_OUTPUT": "true",
  "STREAMING_MODE": "auto",
  "DEEPSEEK_THINKING": "true"
}
```

Settings apply immediately. No restart needed for most changes.

### Key Configuration

| Key | Default | Description |
| --- | ------- | ----------- |
| `DEEPSEEK_THINKING` | `true` | Enable DeepSeek reasoning (`thinking_enabled`). Disable for lower latency on simple tasks. |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | Idle timeout before an upstream stream is considered dead. |
| `MODELS_CACHE_TTL_MS` | `3600000` | How long `/v1/models` caches provider model lists. |
| `CLAUDE_CODE_PROXY` | `false` | Claude Code proxy mode. |
| `RETRY_ENABLED` | `true` | HTTP-level retry with exponential backoff. Upstream 429s skip HTTP retry so model fallback kicks in faster. |

### Via Dashboard

Open `http://localhost:26405/dashboard/settings` (or your configured PORT) for the web config UI. Changes persist to `config.json`.

## Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location /v1/ {
        proxy_pass http://127.0.0.1:26405;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Required for streaming
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}
```

### SSL with Let's Encrypt

```bash
sudo apt install certbot nginx
sudo certbot --nginx -d api.yourdomain.com
```

## Monitoring

### Health Check

```bash
curl http://localhost:26405/v1/models
```

### Application Logs

```bash
pm2 logs opengate                  # Via PM2
journalctl -u opengate -f          # Via systemd
```

`LOG_FORMAT` defaults to `json`. Set to `"text"` for human-readable log output.

### Dashboard

Open `http://localhost:26405/dashboard` (or your configured PORT) for real-time request logs, account status, and session pool stats.

## Security

- Set `API_KEY` in `config.json` — protects all `/v1/*` endpoints
- Run behind nginx with SSL in production
- Use a firewall (`ufw`) to restrict access
- Keep Bun and dependencies updated