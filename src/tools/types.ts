/*
 * File: types.ts
 * Project: qwenproxy
 * Tool system types
 */

/**
 * JSON Schema definition following the OpenAI function calling spec.
 */
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

/**
 * OpenAI-compatible function tool definition.
 */
export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/**
 * Internal tool registration entry.
 */
export interface ToolRegistration {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
  handler: ToolHandler;
}

/**
 * Handler function signature for a registered tool.
 * Receives the parsed and validated arguments.
 * Returns the result as a string (or object that will be JSON-stringified).
 */
export type ToolHandler<TArgs = any, TResult = any> = (
  args: TArgs,
  context: ToolContext
) => Promise<TResult>;

/**
 * Context passed to tool handlers during execution.
 */
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

/**
 * A parsed tool call from the LLM response.
 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a single tool call.
 */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}
