/*
 * File: executor.ts
 * Project: qwenproxy
 * Execution loop for tool calling - agentic loop that handles
 * send -> tool calls -> execute -> re-send until completion
 */

import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall, ToolCallResult, ToolContext } from './types.ts';
import { SchemaValidationError } from './schema.ts';
import { registry } from './registry.ts';
import { robustParseJSON } from '../utils/json.ts';

export interface ExecutionLoopConfig {
  maxTurns?: number;
  debug?: boolean;
}

export interface LoopTurnResult {
  toolCalls: ParsedToolCall[];
  toolResults: ToolCallResult[];
  content: string | null;
  finishReason: string | null;
  turn: number;
}

export type LLMSendFunction = (
  messages: unknown[],
  tools: unknown[] | undefined,
  model: string
) => Promise<LLMResponse>;

export interface LLMResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
}

const TOOL_START_TAG = '<' + 'tool_call>';
const TOOL_END_TAG = '</' + 'tool_call>';

export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = '';

  while (true) {
    const startIdx = remaining.indexOf(TOOL_START_TAG);
    if (startIdx === -1) {
      textContent += remaining;
      break;
    }

    textContent += remaining.substring(0, startIdx);

    const endIdx = remaining.indexOf(TOOL_END_TAG, startIdx + TOOL_START_TAG.length);
    if (endIdx === -1) {
      textContent += remaining.substring(startIdx);
      break;
    }

    const jsonStr = remaining
      .substring(startIdx + TOOL_START_TAG.length, endIdx)
      .trim();

    try {
      const parsed = robustParseJSON(jsonStr);
      if (!parsed) throw new Error('Failed to parse JSON');
      
      toolCalls.push({
        id: 'call_' + uuidv4(),
        name: parsed.name || '',
        arguments: parsed.arguments 
          ? (typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments)
          : (() => {
              const { name, ...rest } = parsed;
              return rest;
            })(),
      });
    } catch (e) {
      textContent += TOOL_START_TAG + jsonStr + TOOL_END_TAG;
    }

    remaining = remaining.substring(endIdx + TOOL_END_TAG.length);
  }

  return { textContent: textContent.trim(), toolCalls };
}

export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext
): Promise<ToolCallResult[]> {
  return await Promise.all(
    toolCalls.map(async (tc) => {
      try {
        if (!registry.has(tc.name)) {
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
            isError: true,
          };
        }

        const result = await registry.execute(tc.name, tc.arguments, context);
        return {
          toolCallId: tc.id,
          name: tc.name,
          result,
          isError: false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isValidation = err instanceof SchemaValidationError;
        return {
          toolCallId: tc.id,
          name: tc.name,
          result: JSON.stringify({
            error: isValidation ? 'Schema validation failed' : 'Tool execution error',
            details: message,
            ...(isValidation ? { path: (err as SchemaValidationError).path } : {}),
          }),
          isError: true,
        };
      }
    })
  );
}

function buildToolMessage(result: ToolCallResult): Record<string, unknown> {
  return {
    role: 'tool',
    tool_call_id: result.toolCallId,
    content: result.result,
  };
}

function buildAssistantToolCallMessage(
  content: string | null,
  toolCalls: ParsedToolCall[]
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments),
      },
    })),
  };
}

export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {}
): Promise<string> {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? false;

  const tools = registry.listNames().length > 0
    ? registry.toOpenAITools()
    : undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (debug) {
      console.log(`[executor] Turn ${turn + 1}/${maxTurns}, messages: ${messages.length}`);
    }

    const response = await sendToLLM(messages, tools, model);

    const hasStructuredToolCalls = response.toolCalls && response.toolCalls.length > 0;
    let parsedFromContent: { textContent: string; toolCalls: ParsedToolCall[] } | null = null;

    if (!hasStructuredToolCalls && response.content) {
      parsedFromContent = parseToolCallsFromContent(response.content);
    }

    const effectiveToolCalls = hasStructuredToolCalls
      ? response.toolCalls
      : parsedFromContent?.toolCalls || [];

    const effectiveContent = parsedFromContent
      ? parsedFromContent.textContent
      : response.content;

    if (effectiveToolCalls.length === 0) {
      if (debug) {
        console.log('[executor] No tool calls, loop complete');
      }
      return effectiveContent || '';
    }

    const context: ToolContext = {
      messages,
      turn,
      model,
    };

    if (debug) {
      console.log(
        `[executor] Executing ${effectiveToolCalls.length} tool calls:`,
        effectiveToolCalls.map((tc) => tc.name)
      );
    }

    const toolResults = await executeToolCalls(effectiveToolCalls, context);

    messages.push(buildAssistantToolCallMessage(effectiveContent, effectiveToolCalls));

    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }

    if (debug) {
      console.log(
        `[executor] Tool results:`,
        toolResults.map((r) => ({ name: r.name, isError: r.isError }))
      );
    }
  }

  throw new Error(
    `Execution loop exceeded maximum turns (${maxTurns}). The agent may be stuck in a cycle.`
  );
}
