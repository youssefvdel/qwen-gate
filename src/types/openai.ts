/*
 * File: openai.ts
 * Project: qwenproxy
 * Unified OpenAI-compatible type definitions
 * Single source of truth for all message, tool, and response types.
 */

// ─── JSON Schema ───────────────────────────────────────────────────────────────

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  nullable?: boolean;
}

// ─── Function Tool Definitions ─────────────────────────────────────────────────

export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

// ─── Tool Choice ───────────────────────────────────────────────────────────────

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

// ─── Messages ──────────────────────────────────────────────────────────────────

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface MessageToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface Message {
  role: string;
  content: string | null;
  tool_calls?: MessageToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

// ─── Request ───────────────────────────────────────────────────────────────────

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
}

// ─── Streaming Response ────────────────────────────────────────────────────────

export interface ToolCallDelta {
  index: number;
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
}

export interface Choice {
  index: number;
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

// ─── Parsed Tool Call (from LLM) ───────────────────────────────────────────────

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ─── Tool Call Result ──────────────────────────────────────────────────────────

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

// ─── Tool Handler ──────────────────────────────────────────────────────────────

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<unknown>;

export interface ToolExecutionContext {
  messages: Message[];
  turn: number;
  model: string;
  state: Record<string, unknown>;
}

// ─── Tool Registration ─────────────────────────────────────────────────────────

export interface ToolRegistration {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
  handler: ToolHandler;
  policy?: ToolPolicy;
}

// ─── Tool Policy ───────────────────────────────────────────────────────────────

export interface ToolPolicy {
  /** Maximum times this tool can be called per agent run */
  maxCallsPerRun?: number;
  /** Whether this tool requires explicit user approval */
  requiresApproval?: boolean;
  /** Rate limit: max calls per minute */
  rateLimit?: number;
  /** Allowed contexts (e.g., only in certain conversation states) */
  allowedContexts?: string[];
}
