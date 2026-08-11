/*
 * File: openai.ts
 * Project: qwenproxy
 * Unified OpenAI-compatible type definitions
 * Single source of truth for all message, tool, and response types.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
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
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  patternProperties?: Record<string, JsonSchema>;
  nullable?: boolean;
  title?: string;
  examples?: unknown[];
}

export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
  inputSchema?: JsonSchema;
}

export type ToolChoice = 'auto' | 'none' | 'required' | 'any' | { type: 'function'; function: { name: string } };

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

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  stream_options?: {
    include_usage?: boolean;
  };
  /** OpenAI-style reasoning effort (low | medium | high) — mapped to Qwen thinking. */
  reasoning_effort?: string;
  /** Client thinking intent (Claude Code `thinking` block, OpenAI `thinking` param). */
  thinking?: { type?: string; enabled?: boolean; budget_tokens?: number; budgetTokens?: number };
  /** Resolved thinking level, set internally by the route handlers. */
  thinkingLevel?: 'off' | 'summary' | 'full';
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelSpec {
  max_context: number;
  max_output: number;
  modalities: string[];
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

export type ToolHandler<TArgs = any, TResult = any> = (args: TArgs, context: ToolContext) => Promise<TResult>;

export interface ToolContext {
  /** The original messages from the request */
  messages: unknown[];
  /** The current turn number in the execution loop */
  turn: number;
  /** The model being used */
  model: string;
  /** Custom state or services can be attached here */
  [key: string]: any;
}

export interface ToolRegistration {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
  handler: ToolHandler;
  policy?: ToolPolicy;
}

export interface ToolPolicy {
  maxCallsPerRun?: number;
  requiresApproval?: boolean;
  rateLimit?: number;
  allowedContexts?: string[];
}
