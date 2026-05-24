import { v4 as uuidv4 } from 'uuid';

export interface NetworkDebugEntry {
  id: string;
  timestamp: string;
  phase: 'pending' | 'streaming' | 'completed' | 'error';
  
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyPreview: string;
    bodySize: number;
  };
  
  response: {
    status: number | null;
    statusText: string;
    headers: Record<string, string>;
  };
  
  stream: {
    chunks: string[];
    totalChunks: number;
    firstChunkAt: string | null;
    lastChunkAt: string | null;
  };
  
  timing: {
    startedAt: number;
    ttfb: number | null;
    totalDuration: number | null;
    chunksPerSecond: number | null;
  };
  
  category: 'chat' | 'session-create' | 'session-delete' | 'models' | 'settings' | 'auth' | 'other';
  accountEmail: string | null;
  errors: string[];
}

export interface NetworkDebugOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  category: NetworkDebugEntry['category'];
  accountEmail?: string;
}

const MAX_ENTRIES = 200;
const MAX_STORED_CHUNKS = 100;
const MAX_BODY_PREVIEW = 2000;

const entries: NetworkDebugEntry[] = [];
const listeners = new Set<(entry: NetworkDebugEntry) => void>();

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey === 'cookie') {
      redacted[key] = value.length > 30 ? `${value.slice(0, 30)}...[redacted]` : value;
    } else if (lowerKey === 'authorization') {
      redacted[key] = 'Bearer ***';
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}

function notifyListeners(entry: NetworkDebugEntry): void {
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (error) {
      // Silently ignore listener errors to prevent breaking the main flow
    }
  }
}

export function createNetworkEntry(options: NetworkDebugOptions): NetworkDebugEntry {
  const entry: NetworkDebugEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    phase: 'pending',
    request: {
      url: options.url,
      method: options.method,
      headers: redactHeaders(options.headers),
      bodyPreview: options.body 
        ? JSON.stringify(options.body).slice(0, MAX_BODY_PREVIEW) 
        : '',
      bodySize: options.body 
        ? new TextEncoder().encode(JSON.stringify(options.body)).length 
        : 0,
    },
    response: {
      status: null,
      statusText: '',
      headers: {},
    },
    stream: {
      chunks: [],
      totalChunks: 0,
      firstChunkAt: null,
      lastChunkAt: null,
    },
    timing: {
      startedAt: Date.now(),
      ttfb: null,
      totalDuration: null,
      chunksPerSecond: null,
    },
    category: options.category,
    accountEmail: options.accountEmail ?? null,
    errors: [],
  };
  
  // Add to front of array (newest first)
  entries.unshift(entry);
  
  // Maintain FIFO - remove oldest if over limit
  if (entries.length > MAX_ENTRIES) {
    entries.pop();
  }
  
  notifyListeners(entry);
  
  return entry;
}

export function recordResponse(entryId: string, response: Response): void {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) {
    return;
  }
  
  const now = Date.now();
  entry.response.status = response.status;
  entry.response.statusText = response.statusText;
  entry.timing.ttfb = now - entry.timing.startedAt;
  
  // Capture response headers
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  entry.response.headers = headers;
  
  notifyListeners(entry);
}

export function recordStreamChunk(entryId: string, chunk: string): void {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) {
    return;
  }
  
  const now = new Date().toISOString();
  
  // Update phase to streaming on first chunk
  if (entry.stream.totalChunks === 0) {
    entry.phase = 'streaming';
    entry.stream.firstChunkAt = now;
  }
  
  // Always increment total count
  entry.stream.totalChunks++;
  entry.stream.lastChunkAt = now;
  
  // Store up to MAX_STORED_CHUNKS
  if (entry.stream.chunks.length < MAX_STORED_CHUNKS) {
    entry.stream.chunks.push(chunk);
  }
  
  notifyListeners(entry);
}

export function completeEntry(entryId: string): void {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) {
    return;
  }
  
  const now = Date.now();
  entry.phase = 'completed';
  entry.timing.totalDuration = now - entry.timing.startedAt;
  
  // Calculate chunks per second if we have chunks and duration
  if (entry.stream.totalChunks > 0 && entry.timing.totalDuration > 0) {
    entry.timing.chunksPerSecond = entry.stream.totalChunks / (entry.timing.totalDuration / 1000);
  }
  
  notifyListeners(entry);
}

export function errorEntry(entryId: string, error: string): void {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) {
    return;
  }
  
  entry.phase = 'error';
  entry.errors.push(error);
  
  // Calculate duration even on error
  const now = Date.now();
  entry.timing.totalDuration = now - entry.timing.startedAt;
  
  notifyListeners(entry);
}

export function getRecentNetworkEntries(count: number = 50): NetworkDebugEntry[] {
  return entries.slice(0, Math.min(count, entries.length));
}

export function getNetworkEntry(id: string): NetworkDebugEntry | undefined {
  return entries.find(e => e.id === id);
}

export function subscribeNetwork(listener: (entry: NetworkDebugEntry) => void): () => void {
  listeners.add(listener);
  
  // Return unsubscribe function
  return () => {
    listeners.delete(listener);
  };
}
