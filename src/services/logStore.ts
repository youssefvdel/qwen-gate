/*
 * File: logStore.ts
 * In-memory log store — captures client requests and Qwen responses
 * for viewing at http://qwen-gate/log (SSE) and http://qwen-gate/log/json
 */

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
  // Qwen -> Proxy (raw chunks, before any filtering)
  qwenRawChunks: string[];
  // Full raw output (all chunks joined, before processing)
  rawFullContent: string;
  // Proxy -> Qwen tool results (if any)
  toolCallResults: Array<{ name: string; isError: boolean; result: string }>;
  // Parser
  parsedToolCalls: Array<{ name: string; args: string }>;
  remainingText: string;
  // Proxy -> Client
  finalResponse: {
    finishReason: string;
    toolCallCount: number;
    contentPreview: string;
  };
  // Errors
  errors: string[];
}

const MAX_ENTRIES = 100;
const MAX_CHUNKS_PER_ENTRY = 50;

class LogStore {
  private entries: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();

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

  // SSE listener management
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const logStore = new LogStore();
