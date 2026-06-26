import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from '../utils/paths.ts';
import { logStore } from './logStore.ts';

export interface ConfigSchema {
  PORT: string;
  HOST: string;
  API_KEY: string;
  TOOL_CALLING: string;
  CLEAN_OUTPUT: string;
  STREAMING_MODE: string;
  MAX_TOOL_CALLS_PER_RESPONSE: string;
  QWEN_FETCH_TIMEOUT_MS: string;
  AUTH_TOKEN_MAX_AGE_MS: string;
  AUTH_REFRESH_BEFORE_MS: string;
  DELETE_SESSION: string;
  RATE_LIMIT_COOLDOWN_MS: string;
  MAX_LOGS: string;
  MAX_LOGIN_ATTEMPTS: string;
  LOGIN_FAIL_THROTTLE_MS: string;
  LOGIN_FAIL_DISABLE_MS: string;
  CLUSTER_WORKER_STAGGER_MS: string;
  CUSTOM_INSTRUCTION: string;
  USE_CUSTOM_INSTRUCTION: string;
  SAVE_REQUEST_LOGS: string;
  RETRY_MAX_ATTEMPTS: string;
  OPEN_DASHBOARD_ON_START: string;
  RETRY_BASE_DELAY_MS: string;
  RETRY_MAX_DELAY_MS: string;
  RETRY_BACKOFF_MULTIPLIER: string;
  RETRY_ENABLED: string;
  STREAM_IDLE_TIMEOUT_MS: string;
  MODELS_CACHE_TTL_MS: string;
  DARK_MODE: string;
  CLAUDE_CODE_PROXY: string;
}

export const DEFAULT_CONFIG: ConfigSchema = {
  PORT: '26405',
  HOST: '',
  API_KEY: '',
  TOOL_CALLING: 'true',
  CLEAN_OUTPUT: 'true',
  STREAMING_MODE: 'auto',
  MAX_TOOL_CALLS_PER_RESPONSE: '3',
  QWEN_FETCH_TIMEOUT_MS: '30000',
  AUTH_TOKEN_MAX_AGE_MS: '28800000',
  AUTH_REFRESH_BEFORE_MS: '300000',
  DELETE_SESSION: 'true',
  RATE_LIMIT_COOLDOWN_MS: '120000',
  MAX_LOGS: '50',
  MAX_LOGIN_ATTEMPTS: '3',
  LOGIN_FAIL_THROTTLE_MS: '1800000',
  LOGIN_FAIL_DISABLE_MS: '7200000',
  CLUSTER_WORKER_STAGGER_MS: '2000',
  CUSTOM_INSTRUCTION: '',
  USE_CUSTOM_INSTRUCTION: 'false',
  SAVE_REQUEST_LOGS: 'false',
  RETRY_MAX_ATTEMPTS: '3',
  OPEN_DASHBOARD_ON_START: 'false',
  RETRY_BASE_DELAY_MS: '1000',
  RETRY_MAX_DELAY_MS: '30000',
  RETRY_BACKOFF_MULTIPLIER: '2',
  RETRY_ENABLED: 'true',
  STREAM_IDLE_TIMEOUT_MS: '60000',
  MODELS_CACHE_TTL_MS: '3600000',
  DARK_MODE: 'false',
  CLAUDE_CODE_PROXY: 'false',
};

const CONFIG_KEYS = new Set<string>(Object.keys(DEFAULT_CONFIG));

export function isValidKey(key: string): key is keyof ConfigSchema {
  return CONFIG_KEYS.has(key);
}

function getConfigFilePath(): string {
  return projectPath('config.json');
}

export class ConfigService {
  private _data: Partial<ConfigSchema> = {};
  private _filePath: string;

  constructor(filePath?: string) {
    // Allow injecting file path for testing
    this._filePath = filePath ?? getConfigFilePath();
    this.load();
  }

  load(): void {
    const filePath = this._filePath;
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);

        // Warn about unknown keys
        for (const key of Object.keys(parsed)) {
          if (!CONFIG_KEYS.has(key)) {
            logStore.log('debug', 'config', `[config] Unknown key "${key}" in config.json — ignoring`);
          }
        }

        // Only accept known keys
        const clean: Partial<ConfigSchema> = {};
        for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
          if (typeof parsed[key] === 'string') {
            clean[key] = parsed[key];
          }
        }
        this._data = clean;
        this.validate();
      } catch {
        // Bad JSON or read failure → use defaults
        this._data = {};
      }
    } else {
      // File missing → create it with defaults
      this._data = {};
      try {
        writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      } catch {
        // If we can't write (e.g. readonly fs in test), just keep empty _data
      }
    }
  }

  validate(): void {
    const port = parseInt(this.get('PORT'), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      logStore.log('debug', 'config', `[config] PORT "${this.get('PORT')}" is invalid, using default ${DEFAULT_CONFIG.PORT}`);
    }

    const checkPositive = (key: keyof ConfigSchema, name: string): void => {
      const val = parseInt(this.get(key), 10);
      if (!isNaN(val) && val < 0) {
        logStore.log('debug', 'config', `[config] ${name} (${key}) is negative (${val}), using default ${DEFAULT_CONFIG[key]}`);
      }
    };

    checkPositive('AUTH_TOKEN_MAX_AGE_MS', 'AUTH_TOKEN_MAX_AGE_MS');
    checkPositive('MAX_LOGS', 'MAX_LOGS');
    checkPositive('QWEN_FETCH_TIMEOUT_MS', 'QWEN_FETCH_TIMEOUT_MS');
    checkPositive('RATE_LIMIT_COOLDOWN_MS', 'RATE_LIMIT_COOLDOWN_MS');
    checkPositive('RETRY_MAX_ATTEMPTS', 'RETRY_MAX_ATTEMPTS');
    checkPositive('RETRY_BASE_DELAY_MS', 'RETRY_BASE_DELAY_MS');
    checkPositive('RETRY_MAX_DELAY_MS', 'RETRY_MAX_DELAY_MS');
    checkPositive('AUTH_REFRESH_BEFORE_MS', 'AUTH_REFRESH_BEFORE_MS');
    checkPositive('MAX_TOOL_CALLS_PER_RESPONSE', 'MAX_TOOL_CALLS_PER_RESPONSE');
  }

  get<K extends keyof ConfigSchema>(key: K, defaultValue?: string): string {
    const envVal = process.env[key];
    if (envVal !== undefined) return envVal;

    if (this._data[key] !== undefined) return this._data[key]!;

    if (defaultValue !== undefined) return defaultValue;

    return DEFAULT_CONFIG[key];
  }

  /** Get a config value as an integer. Returns `defaultValue` when unset or NaN. */
  getInt<K extends keyof ConfigSchema>(key: K, defaultValue: number = 0): number {
    const val = parseInt(this.get(key), 10);
    return isNaN(val) ? defaultValue : val;
  }

  /** Get a config value as a float. Returns `defaultValue` when unset or NaN. */
  getFloat<K extends keyof ConfigSchema>(key: K, defaultValue: number = 0): number {
    const val = parseFloat(this.get(key));
    return isNaN(val) ? defaultValue : val;
  }

  /** Get a config value as a boolean. Accepts 'true'/'false', '1'/'0', case-insensitive. */
  getBool<K extends keyof ConfigSchema>(key: K, defaultValue: boolean = false): boolean {
    const val = this.get(key);
    if (val === 'true' || val === '1') return true;
    if (val === 'false' || val === '0') return false;
    return defaultValue;
  }

  /** Get the validated server port (1-65535). */
  getPort(defaultValue: number = 26405): number {
    const port = parseInt(this.get('PORT'), 10);
    if (isNaN(port) || port < 1 || port > 65535) return defaultValue;
    return port;
  }

  set<K extends keyof ConfigSchema>(key: K, value: string): void {
    this._data[key] = value;
  }

  getAll(): ConfigSchema {
    const result = {} as ConfigSchema;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof ConfigSchema)[]) {
      result[key] = process.env[key] ?? this._data[key] ?? DEFAULT_CONFIG[key];
    }
    return result;
  }

  save(): void {
    writeFileSync(this._filePath, JSON.stringify(this._data, null, 2) + '\n', 'utf-8');
  }

  reset(): void {
    this.load();
  }
}

/** Write or remove `.claude/settings.json` with proxy config for Claude Code. */
export function updateClaudeCodeSettings(cfg: ConfigSchema): void {
  const enabled = cfg.CLAUDE_CODE_PROXY === 'true';
  const settingsDir = projectPath('.claude');
  const settingsFile = join(settingsDir, 'settings.json');

  if (enabled) {
    const host = cfg.HOST || 'localhost';
    const port = cfg.PORT || '26405';
    const baseUrl = `http://${host}:${port}`;
    const settings = {
      _comment: 'Managed by qwen-gate — CLAUDE_CODE_PROXY toggle in dashboard',
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: 'unused',
      },
    };
    try {
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    } catch (err) {
      console.error('[Claude Code] Failed to write .claude/settings.json:', err);
    }
  } else {
    // Remove managed proxy entry from .claude/settings.json
    try {
      if (existsSync(settingsFile)) {
        const raw = readFileSync(settingsFile, 'utf-8');
        const content = JSON.parse(raw);
        // Only touch files we manage (have our _comment marker or ANTHROPIC_BASE_URL)
        if (content._comment?.includes('qwen-gate') || content.env?.ANTHROPIC_BASE_URL) {
          delete content._comment;
          delete content.env?.ANTHROPIC_BASE_URL;
          delete content.env?.ANTHROPIC_AUTH_TOKEN;
          if (content.env && Object.keys(content.env).length === 0) delete content.env;
          if (Object.keys(content).length === 0) {
            unlinkSync(settingsFile);
            // Also remove .claude dir if empty
            try {
              const rest = readdirSync(settingsDir);
              if (rest.length === 0) rmdirSync(settingsDir);
            } catch {}
          } else {
            writeFileSync(settingsFile, JSON.stringify(content, null, 2) + '\n');
          }
          console.log('[Claude Code] Proxy disabled — .claude/settings.json cleaned');
        }
      }
    } catch {
      // best effort cleanup
    }
  }
}

export const config = new ConfigService();
