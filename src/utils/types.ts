/*
 * File: types.ts
 * Re-exports all types from the single source of truth: src/types/openai.ts
 * Kept for backward compatibility — new code should import from types/openai.ts directly.
 */

export type {
  JsonSchema,
  FunctionToolDefinition,
  ToolChoice,
  ToolCallFunction,
  MessageToolCall,
  Message,
  OpenAIRequest,
  ToolCallDelta,
  ChoiceDelta,
  Choice,
  Usage,
  ChatCompletionChunk,
  ParsedToolCall,
  ToolCallResult,
  ToolHandler,
  ToolContext,
  ToolRegistration,
} from '../types/openai.ts';
