/*
 * File: logStore.ts
 * In-memory request log store — captures client requests and Qwen responses
 * for viewing at http://opengate/log (SSE) and http://opengate/log/json
 *
 * System-level logging has been extracted to SystemLogger (systemLogger.ts).
 */
import { mkdirSync, readdirSync, unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from './configService.ts';
import {
  getAllModelHealth as _getAllModelHealth,
  getModelHealth as _getModelHealth,
  recordModelError as _recordModelError,
  recordModelSuccess as _recordModelSuccess,
  resetModelHealth as _resetModelHealth,
} from './modelHealth.ts';
import { monitorStore } from './monitorStore.ts';
import { __registerLogStore, SystemLogger } from './systemLogger.ts';

export type { LogLevel, SystemLogEntry, SystemLogFilter } from './systemLogger.ts';
export { logStore } from './systemLogger.ts';
export interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  turnId?: string;
  stream: boolean;
  accountEmail: string;
  level: import('./systemLogger.ts').LogLevel;
  request_id: string;
  latency_ms: number | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  input?: string; // Sanitized prompt for display
  rawRequestBody?: Record<string, unknown> | string; // Full OpenAI request body
  rawResponse?: string; // Full raw response from Qwen (not truncated)
  processedResponse?: string; // After content filtering/tool parsing
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    success: boolean;
    blocked?: boolean;
    blockReason?: string;
    error?: string;
    executionTimeMs?: number;
  }>;
  networkTiming?: {
    dnsLookup: number;
    tcpConnect: number;
    tlsHandshake: number;
    firstByte: number;
    total: number;
  };
  // Dashboard fields
  clientRequest?: {
    messageCount: number;
    roles: string[];
    hasTools: boolean;
    toolNames: string[];
    tool_choice: unknown | null;
    lastMessage: string;
    messages: Array<{ role: string; content: string }>;
  };
  promptToQwen?: {
    systemPromptLength: number;
    totalLength: number;
    preview: string;
    /** Estimated tokens in client's original messages (pre-inflation) */
    clientTokens?: number;
    /** Estimated tokens from content injected by opengate (system prompt, formatting, tool instructions) */
    overheadTokens?: number;
    /** Total estimated tokens sent to Qwen (clientTokens + overheadTokens) */
    estimatedTotalTokens?: number;
  };
  promptToDeepSeek?: {
    totalLength: number;
    preview: string;
  };
  qwenRawChunks: string[];
  rawFullContent: string;
  parsedToolCalls: Array<{ name: string; args: string }>;
  remainingText: string;
  processedApiOutput: string;
  finalResponse?: {
    finishReason: string;
    toolCallCount: number;
    contentPreview: string;
  };
  errors: string[];
  reasoningContent?: string;
  amplificationRatio?: number;
  amplificationTriggeredInput?: string;
  apiType?: 'openai' | 'anthropic';
}
const MAX_CHUNKS_PER_ENTRY = 100;
const MAX_FIELD_LENGTH = 10240;
export class RequestLogStore extends SystemLogger {
  private _maxEntries: number | undefined;
  private get maxEntries(): number {
    if (this._maxEntries === undefined) {
      try {
        this._maxEntries = config.getInt('MAX_LOGS', 50);
      } catch {
        this._maxEntries = 50;
      }
    }
    return this._maxEntries;
  }
  private entries: LogEntry[] = [];
  private entryMap: Map<string, LogEntry> = new Map();
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private serverStartTime = Date.now();
  private requestLogDir: string | null = null;
  private requestDirMap: Map<string, string> = new Map();
  private requestFileCount = 0; // Track files written since last cleanup

  /**
   * Enable per-request file logging. Each request gets a single JSON file
   * under `dirPath/<date>/<timestamp>_<id>.json`.
   */
  enableRequestFileLogging(dirPath: string): void {
    try {
      mkdirSync(dirPath, { recursive: true });
      this.requestLogDir = dirPath;
    } catch {
      this.requestLogDir = null;
    }
  }

  getRequestLogDir(): string | null {
    return this.requestLogDir;
  }

  saveRequestInput(_id: string, _body: unknown): void {
    // No-op — input is included in the single JSON log file at completion
  }

  createEntry(id: string, model: string, stream: boolean, requestId?: string, accountEmail?: string): LogEntry {
    return this.createLogEntry(id, model, stream, requestId, accountEmail);
  }
  createLogEntry(id: string, model: string, stream: boolean, requestId?: string, accountEmail?: string): LogEntry {
    const entry: LogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model,
      stream,
      accountEmail: accountEmail || '',
      // Structured log fields for external aggregators
      level: 'info',
      request_id: requestId ?? id,
      latency_ms: null,
      tokens: null,
      clientRequest: {
        messageCount: 0,
        roles: [],
        hasTools: false,
        toolNames: [],
        tool_choice: null,
        lastMessage: '',
        messages: [],
      },
      promptToQwen: {
        systemPromptLength: 0,
        totalLength: 0,
        preview: '',
      },
      qwenRawChunks: [],
      rawFullContent: '',
      parsedToolCalls: [],
      remainingText: '',
      processedApiOutput: '',
      finalResponse: {
        finishReason: 'stop',
        toolCallCount: 0,
        contentPreview: '',
      },
      errors: [],
    };
    this.entries.unshift(entry);
    this.entryMap.set(entry.id, entry);
    const maxEntries = this.maxEntries;
    if (this.entries.length > maxEntries) {
      const removed = this.entries.pop();
      if (removed) this.entryMap.delete(removed.id);
    }
    return entry;
  }
  updateEntry(id: string, updater: (entry: LogEntry) => void): void {
    const entry = this.entryMap.get(id);
    if (!entry) return;
    updater(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
  addRawChunk(id: string, chunk: string): void {
    this.updateEntry(id, (entry) => {
      if (entry.qwenRawChunks.length < MAX_CHUNKS_PER_ENTRY) {
        entry.qwenRawChunks.push(chunk);
      }
    });
  }
  addProcessedOutput(id: string, content: string): void {
    this.updateEntry(id, (entry) => {
      if (entry.processedApiOutput.length < MAX_FIELD_LENGTH) {
        entry.processedApiOutput += content;
        if (entry.processedApiOutput.length > MAX_FIELD_LENGTH) {
          entry.processedApiOutput = entry.processedApiOutput.substring(0, MAX_FIELD_LENGTH) + '... [truncated]';
        }
      }
    });
  }
  recordAmplificationEvent(logId: string, ratio: number, triggeringInput: string): void {
    this.updateEntry(logId, (entry) => {
      entry.amplificationRatio = ratio;
      entry.amplificationTriggeredInput =
        triggeringInput.length > 2000
          ? triggeringInput.substring(0, 2000) + `... [truncated ${triggeringInput.length - 2000} more chars]`
          : triggeringInput;
    });
  }

  getEntry(id: string): LogEntry | undefined {
    return this.entryMap.get(id);
  }
  addError(id: string, error: string): void {
    this.updateEntry(id, (entry) => {
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
    this.updateEntry(id, (entry) => {
      entry.networkTiming = timing;
    });
  }
  // SSE listener management
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // Uptime in seconds since server start
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.serverStartTime) / 1000);
  }
  recordModelError(model: string): void {
    _recordModelError(model);
  }
  recordModelSuccess(model: string): void {
    _recordModelSuccess(model);
  }
  getModelHealth(model: string): {
    errors: number;
    successes: number;
    errorRate: number;
    isHealthy: boolean;
  } {
    return _getModelHealth(model);
  }
  resetModelHealth(model: string): void {
    _resetModelHealth(model);
  }
  getAllModelHealth(): Record<string, { successCount: number; errorCount: number; lastActivity: string }> {
    return _getAllModelHealth();
  }
  private toolCallValidationFailures = 0;
  private hallucinatedToolNames = 0;
  /**
   * Increment counter for tool call validation failures
   * (e.g., JSON parse errors, schema mismatches, guard rejections)
   */
  recordToolCallValidationFailure(): void {
    this.toolCallValidationFailures++;
  }
  /**
   * Increment counter for hallucinated tool names
   * (e.g., model invents tool not in available_tools registry)
   */
  recordHallucinatedToolName(): void {
    this.hallucinatedToolNames++;
  }
  /**
   * Get tool discipline metrics for observability/Prometheus export
   */
  getToolDisciplineMetrics(): {
    toolCallValidationFailures: number;
    hallucinatedToolNames: number;
  } {
    return {
      toolCallValidationFailures: this.toolCallValidationFailures,
      hallucinatedToolNames: this.hallucinatedToolNames,
    };
  }
  /**
   * Reset tool discipline metrics (useful for testing or manual recovery)
   */
  resetToolDisciplineMetrics(): void {
    this.toolCallValidationFailures = 0;
    this.hallucinatedToolNames = 0;
  }
  finalizeRequest(
    id: string,
    options?: {
      latencyMs?: number;
      tokens?: { prompt: number; completion: number; total: number };
      finishReason?: string;
    },
  ): void {
    if (options) {
      this.updateEntry(id, (entry) => {
        if (options.latencyMs !== undefined) entry.latency_ms = options.latencyMs;
        if (options.tokens) entry.tokens = options.tokens;
        if (options.finishReason && entry.finalResponse) {
          entry.finalResponse.finishReason = options.finishReason;
        }
      });
    }
    if (config.get('SAVE_REQUEST_LOGS') === 'true') {
      this.saveRequestLog(id);
    }

    // Record to persistent monitor store (survives restarts)
    const entry = this.entryMap.get(id);
    if (entry && entry.accountEmail) {
      const hasErrors = (entry.errors && entry.errors.length > 0) || entry.finalResponse?.finishReason === 'error';
      monitorStore.record({
        accountEmail: entry.accountEmail,
        model: entry.model || 'unknown',
        stream: entry.stream,
        success: !hasErrors,
        latencyMs: entry.latency_ms,
        error: entry.errors?.length ? entry.errors[0] : null,
      });
    }
  }

  private saveRequestLog(id: string): void {
    if (!this.requestLogDir) return;
    const entry = this.entryMap.get(id);
    if (!entry) return;
    const d = new Date(entry.timestamp);
    const y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const dateStr = `${y}-${M}-${day}`;
    const timeStr = `${h}-${min}-${s}`;
    try {
      const toolCalls = (entry.parsedToolCalls || []).map((tc) => {
        let args: unknown = tc.args;
        try {
          args = JSON.parse(tc.args);
        } catch {
          /* keep string */
        }
        return { name: tc.name, arguments: args };
      });
      const payload = {
        id: entry.id,
        timestamp: entry.timestamp,
        account: entry.accountEmail,
        model: entry.model,
        api_type: entry.apiType || 'openai',
        finish_reason: entry.finalResponse?.finishReason || null,
        stream: entry.stream,
        latency_ms: entry.latency_ms,
        prompt_to_deepseek: entry.promptToDeepSeek || null,
        thinking_content: entry.reasoningContent || '',
        raw_output: entry.rawFullContent || '',
        proccessed_output: entry.processedApiOutput || '',
        tool_call_count: toolCalls.length,
        tool_calls: toolCalls,
        errors: entry.errors || [],
        chunks: entry.qwenRawChunks || [],
        input: entry.clientRequest || {},
      };
      const fileName = `${dateStr}_${timeStr}.json`;
      const filePath = join(this.requestLogDir, fileName);
      // Periodic cleanup instead of readdirSync+sort on every request
      this.requestFileCount++;
      if (this.requestFileCount % 50 === 0) {
        try {
          const files = readdirSync(this.requestLogDir).sort();
          if (files.length >= 1000) {
            const toRemove = files.slice(0, files.length - 999);
            for (const f of toRemove) unlinkSync(join(this.requestLogDir, f));
          }
        } catch {
          /* cleanup is best-effort */
        }
      }
      writeFile(filePath, JSON.stringify(payload, null, 2)).catch((err) =>
        console.error('[LogStore] Failed to write request log:', err.message),
      );
    } catch {
      /* disk write best-effort */
    }
  }
}

const logStoreInstance = new RequestLogStore();
__registerLogStore(logStoreInstance);
