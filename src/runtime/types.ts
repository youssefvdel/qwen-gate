/*
 * File: types.ts
 * Project: qwenproxy
 * Agent runtime state machine types
 */

import type { Message, ParsedToolCall, ToolCallResult, FunctionToolDefinition, ToolPolicy } from '../types/openai.ts';

// ─── Agent Lifecycle States ──────────────────────────────────────────────────

export type AgentPhase =
  | 'idle'          // Agent created, not yet started
  | 'planning'      // Building messages, injecting tools
  | 'calling_llm'   // Waiting for LLM response
  | 'parsing'       // Parsing LLM response for tool calls
  | 'executing'     // Running tool calls
  | 'streaming'     // Forwarding stream to client
  | 'completed'     // Final response delivered
  | 'error'         // Unrecoverable error
  | 'aborted';      // User/system aborted

// ─── Agent State ─────────────────────────────────────────────────────────────

export interface AgentState {
  /** Current lifecycle phase */
  phase: AgentPhase;
  /** Unique run identifier */
  runId: string;
  /** Original request model */
  model: string;
  /** Whether to stream the response */
  stream: boolean;

  /** Working message list (mutable across turns) */
  messages: Message[];
  /** Available tool definitions for this run */
  tools: FunctionToolDefinition[];

  /** Current turn number (0-indexed) */
  turn: number;
  /** Maximum allowed turns */
  maxTurns: number;

  /** Accumulated tool calls from the current turn */
  pendingToolCalls: ParsedToolCall[];
  /** Results from executed tool calls */
  toolResults: ToolCallResult[];

  /** Final text content returned by the agent */
  finalContent: string | null;
  /** Finish reason: 'stop' | 'tool_calls' | 'error' | null */
  finishReason: string | null;

  /** Token usage tracking */
  usage: AgentUsage;

  /** Error information if phase is 'error' */
  error: AgentError | null;

  /** Timestamp tracking */
  timestamps: AgentTimestamps;

  /** Arbitrary per-run state for tools */
  state: Record<string, unknown>;
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

// ─── Error ───────────────────────────────────────────────────────────────────

export interface AgentError {
  code: string;
  message: string;
  phase: AgentPhase;
  recoverable: boolean;
  cause?: unknown;
}

// ─── Timestamps ──────────────────────────────────────────────────────────────

export interface AgentTimestamps {
  created: number;
  started?: number;
  completed?: number;
  lastTurnAt?: number;
  erroredAt?: number;
}

// ─── Agent Configuration ─────────────────────────────────────────────────────

export interface AgentConfig {
  /** Maximum number of agentic turns before forcing stop */
  maxTurns?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Request timeout in ms per LLM call */
  llmTimeout?: number;
  /** Tool execution timeout in ms */
  toolTimeout?: number;
  /** Custom state seed */
  initialState?: Record<string, unknown>;
}

// ─── Event Types (for observability) ─────────────────────────────────────────

export type AgentEvent =
  | { type: 'phase_change'; from: AgentPhase; to: AgentPhase; timestamp: number }
  | { type: 'llm_request'; turn: number; messageCount: number; timestamp: number }
  | { type: 'llm_response'; turn: number; contentLength: number; toolCallCount: number; timestamp: number }
  | { type: 'tool_start'; turn: number; toolName: string; toolCallId: string; timestamp: number }
  | { type: 'tool_end'; turn: number; toolName: string; toolCallId: string; isError: boolean; duration: number; timestamp: number }
  | { type: 'stream_chunk'; turn: number; chunkSize: number; timestamp: number }
  | { type: 'error'; phase: AgentPhase; code: string; message: string; timestamp: number }
  | { type: 'completed'; turn: number; totalTokens: number; duration: number; timestamp: number };

export type AgentEventListener = (event: AgentEvent) => void;

// ─── LLM Adapter Types ──────────────────────────────────────────────────────

export interface LLMResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
  usage?: Partial<AgentUsage>;
}

export interface LLMStreamChunk {
  /** Text content delta */
  content?: string;
  /** Reasoning/thinking delta */
  reasoning?: string;
  /** Tool call deltas (partial) */
  toolCalls?: ParsedToolCall[];
  /** True when stream is done */
  done: boolean;
  /** Finish reason when done */
  finishReason?: string;
  /** Usage when done */
  usage?: Partial<AgentUsage>;
}

export type LLMAdapter = {
  /** Send messages and get a complete response */
  complete(
    messages: Message[],
    tools: FunctionToolDefinition[] | undefined,
    model: string,
    signal?: AbortSignal
  ): Promise<LLMResponse>;

  /** Send messages and get a streaming response */
  stream(
    messages: Message[],
    tools: FunctionToolDefinition[] | undefined,
    model: string,
    signal?: AbortSignal
  ): AsyncGenerator<LLMStreamChunk>;
};
