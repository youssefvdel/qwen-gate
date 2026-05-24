/*
 * File: types.ts
 * Project: qwen-gate
 * Tool system types — re-exports shared types from src/types/openai.ts
 * to maintain a single source of truth.
 */

// Re-export all shared tool types from the central type definitions
export type {
  JsonSchema,
  FunctionToolDefinition,
  ToolChoice,
  ParsedToolCall,
  ToolCallResult,
  ToolHandler,
  ToolContext,
  ToolRegistration,
} from '../types/openai.ts';
