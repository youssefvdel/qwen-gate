/*
 * File: logStore.ts
 * In-memory log store — captures client requests and Qwen responses
 * for viewing at http://qwen-gate/log (SSE) and http://qwen-gate/log/json
 *
 * Also provides a system-level logger with levels, categories, filtering,
 * and optional file persistence for operational events (auth, circuit breaker,
 * session pool, streaming failures, etc.).
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

// ─── System Log Levels & Categories ─────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SystemLogFilter {
  minLevel?: LogLevel;
  category?: string;
  since?: string;
  limit?: number;
}

// ─── Request Log Entry (existing) ───────────────────────────────────────────────

export interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  stream: boolean;
  // Client -> Proxy
  clientRequest: {
    messageCount: number;
    roles: string[];
    hasTools: boolean;
    toolNames: string[];
    tool_choice: string | null;
    lastMessage: string;
  };
  // Proxy -> Qwen
  promptToQwen: {
    systemPromptLength: number;
    totalLength: number;
    preview: string;
  };
  // Qwen -> Proxy (ALL raw chunks, before any filtering)
  qwenRawChunks: string[];
  // Full raw output (all chunks joined, before processing)
  rawFullContent: string;
  // Proxy -> Qwen tool results (if any)
  toolCallResults: Array<{ name: string; isError: boolean; result: string }>;
  // Parser
  parsedToolCalls: Array<{ name: string; args: string }>;
  remainingText: string;
  // Proxy -> Client (what the client actually receives after all processing)
  processedApiOutput: string;
  finalResponse: {
    finishReason: string;
    toolCallCount: number;
    contentPreview: string;
  };
  // Errors
  errors: string[];
  // Amplification monitoring
  amplificationRatio?: number;
  amplificationTriggeredInput?: string;
  networkTiming?: {
    ttfb: number | null;           // ms
    totalDuration: number | null;  // ms
    chunksReceived: number;
    chunksPerSecond: number | null;
    debugEntryId: string;          // link to full network debug entry
  };
}

const MAX_ENTRIES = 100;
const MAX_CHUNKS_PER_ENTRY = 50;
const MAX_SYSTEM_ENTRIES = 500;

class LogStore {
  private entries: LogEntry[] = [];
  private systemEntries: SystemLogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private systemListeners: Set<(entry: SystemLogEntry) => void> = new Set();
  private persistencePath: string | null = null;
  private requestLogPath: string | null = null;
  private systemIdCounter = 0;

  enablePersistence(dirPath: string): void {
    try {
      mkdirSync(dirPath, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      this.persistencePath = resolve(dirPath, `qwen-gate-${date}.log`);
      this.requestLogPath = resolve(dirPath, `requests-${date}.jsonl`);
      console.log(`[LogStore] Persistence enabled: ${this.persistencePath}`);
      console.log(`[LogStore] Request log: ${this.requestLogPath}`);
    } catch (err) {
      console.error(`[LogStore] Failed to enable persistence:`, err);
    }
  }

  /**
   * Persist a completed request entry to the request log file.
   * Records both the raw Qwen output and the processed API output sent to the client.
   * Call this once per request at the end of the chat completion handler.
   */
  persistRequest(entry: LogEntry): void {
    if (!this.requestLogPath) return;
    try {
      const record = {
        id: entry.id,
        timestamp: entry.timestamp,
        model: entry.model,
        stream: entry.stream,
        finishReason: entry.finalResponse?.finishReason || '',
        clientRequest: entry.clientRequest,
        // What Qwen actually produced (before any filtering)
        qwenRawOutput: entry.rawFullContent || (entry.qwenRawChunks || []).join(''),
        // What the API actually sent to the client (after parsing + filtering)
        processedApiOutput: entry.processedApiOutput || '',
        parsedToolCalls: entry.parsedToolCalls,
        errors: entry.errors,
        networkTiming: entry.networkTiming,
      };
      appendFileSync(this.requestLogPath, JSON.stringify(record) + '\n');
    } catch (err) {
      // Swallow write errors — logging must never break the request path
    }
  }

  log(level: LogLevel, category: string, message: string, metadata?: Record<string, unknown>): void {
    const entry: SystemLogEntry = {
      id: `sys-${++this.systemIdCounter}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    };
    this.systemEntries.unshift(entry);
    if (this.systemEntries.length > MAX_SYSTEM_ENTRIES) this.systemEntries.pop();

    for (const listener of this.systemListeners) {
      try { listener(entry); } catch {}
    }

    if (this.persistencePath) {
      try {
        const line = JSON.stringify(entry) + '\n';
        appendFileSync(this.persistencePath, line);
      } catch {}
    }

    const prefix = `[${level.toUpperCase()}]`;
    const meta = metadata ? ` ${JSON.stringify(metadata)}` : '';
    if (level === 'error') console.error(`${prefix} [${category}] ${message}${meta}`);
    else if (level === 'warn') console.warn(`${prefix} [${category}] ${message}${meta}`);
    else console.log(`${prefix} [${category}] ${message}${meta}`);
  }

  debug(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', category, message, metadata);
  }
  info(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('info', category, message, metadata);
  }
  warn(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', category, message, metadata);
  }
  error(category: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('error', category, message, metadata);
  }

  getSystemLogs(filter?: SystemLogFilter): SystemLogEntry[] {
    let result = this.systemEntries;
    if (filter?.minLevel) {
      const minRank = LOG_LEVEL_RANK[filter.minLevel];
      result = result.filter(e => LOG_LEVEL_RANK[e.level] >= minRank);
    }
    if (filter?.category) {
      result = result.filter(e => e.category === filter.category);
    }
    if (filter?.since) {
      result = result.filter(e => e.timestamp >= filter.since!);
    }
    return result.slice(0, filter?.limit ?? 100);
  }

  subscribeSystem(listener: (entry: SystemLogEntry) => void): () => void {
    this.systemListeners.add(listener);
    return () => { this.systemListeners.delete(listener); };
  }

  createEntry(id: string, model: string, stream: boolean): LogEntry {
    const entry: LogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model,
      stream,
      clientRequest: {
        messageCount: 0,
        roles: [],
        hasTools: false,
        toolNames: [],
        tool_choice: null,
        lastMessage: '',
      },
      promptToQwen: {
        systemPromptLength: 0,
        totalLength: 0,
        preview: '',
      },
      qwenRawChunks: [],
      rawFullContent: '',
      toolCallResults: [],
      parsedToolCalls: [],
      remainingText: '',
      processedApiOutput: '',
      finalResponse: {
        finishReason: '',
        toolCallCount: 0,
        contentPreview: '',
      },
      errors: [],
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.pop();
    return entry;
  }

  updateEntry(id: string, updater: (entry: LogEntry) => void): void {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    updater(entry);
    // Notify SSE listeners
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  addRawChunk(id: string, chunk: string): void {
    this.updateEntry(id, entry => {
      if (entry.qwenRawChunks.length < MAX_CHUNKS_PER_ENTRY) {
        entry.qwenRawChunks.push(chunk);
      }
      entry.rawFullContent += chunk;
    });
  }

  /** Record an amplification event when output vastly exceeds input */
  recordAmplificationEvent(logId: string, ratio: number, triggeringInput: string): void {
    this.updateEntry(logId, entry => {
      entry.amplificationRatio = ratio;
      entry.amplificationTriggeredInput = triggeringInput.length > 2000
        ? triggeringInput.substring(0, 2000) + `... [truncated ${triggeringInput.length - 2000} more chars]`
        : triggeringInput;
    });
  }

  /** Append content that was actually sent to the client (after all processing) */
  addProcessedOutput(id: string, content: string): void {
    this.updateEntry(id, entry => {
      entry.processedApiOutput += content;
    });
  }

  addError(id: string, error: string): void {
    this.updateEntry(id, entry => {
      entry.errors.push(error);
    });
  }

  getRecent(count = 20): LogEntry[] {
    return this.entries.slice(0, count);
  }

  getAll(): LogEntry[] {
    return this.entries;
  }

  setNetworkTiming(id: string, timing: LogEntry['networkTiming']): void {
    this.updateEntry(id, entry => {
      entry.networkTiming = timing;
    });
  }

  // SSE listener management
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const logStore = new LogStore();
