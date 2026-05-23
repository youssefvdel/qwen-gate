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
import { validateToolCalls } from './guard.ts';

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

export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = '';

  while (true) {
    const nameIdx = remaining.indexOf('"name"');
    if (nameIdx === -1) {
      textContent += remaining;
      break;
    }

    const searchFrom = Math.max(0, nameIdx - 300);
    const braceIdx = remaining.lastIndexOf('{', nameIdx);
    if (braceIdx === -1 || braceIdx < searchFrom) {
      textContent += remaining[0] || '';
      remaining = remaining.substring(1);
      continue;
    }

    if (braceIdx > 0) {
      textContent += remaining.substring(0, braceIdx);
    }

    let after = remaining.substring(braceIdx);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let i = 0;

    while (i < after.length) {
      const c = after[i];
      if (escaped) { escaped = false; i++; continue; }
      if (c === '\\') { escaped = true; i++; continue; }
      if (c === '"') { inString = !inString; i++; continue; }
      if (inString) { i++; continue; }
      if (c === '{' || c === '[') { depth++; i++; continue; }
      if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
        i++;
      } else {
        i++;
      }
    }

    if (depth !== 0) {
      textContent += remaining;
      break;
    }

    const jsonStr = after.substring(0, i);

    try {
      const parsed = robustParseJSON(jsonStr);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');

      let args = parsed.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (typeof args !== 'object' || Array.isArray(args)) args = {};

      toolCalls.push({
        id: 'call_' + uuidv4(),
        name: parsed.name || '',
        arguments: args || (() => { const { name, ...rest } = parsed; return rest; })(),
      });
    } catch {
      textContent += jsonStr;
    }

    remaining = after.substring(i);
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
  const msg: Record<string, unknown> = {
    role: 'assistant',
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
  if (content) msg.content = content;
  return msg;
}

function normalizeToolCalls(toolCalls: ParsedToolCall[]): { fixed: ParsedToolCall[] } {
  const fixed: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    try {
      let args = tc.arguments;
      if (typeof args === 'string') {
        const argStr: string = args;
        try { args = JSON.parse(argStr); } catch {
          const repaired = repairJson(argStr);
          if (repaired) try { args = JSON.parse(repaired); } catch { continue; }
          else continue;
        }
      }
      if (typeof args !== 'object' || Array.isArray(args) || !args) continue;
      const name = tc.name?.trim() || '';
      if (!name) continue;
      fixed.push({ id: tc.id || 'call_' + uuidv4(), name, arguments: args });
    } catch { continue; }
  }
  return { fixed };
}

function repairJson(raw: string): string | null {
  if (!raw || raw.trim().length < 2) return null;
  let s = raw.trim();
  s = s.replace(/,\s*([}\]])/g, '$1');
  const openCurly = (s.match(/{/g) || []).length;
  const closeCurly = (s.match(/}/g) || []).length;
  const openBracket = (s.match(/\[/g) || []).length;
  const closeBracket = (s.match(/\]/g) || []).length;
  if (openCurly > closeCurly) s += '}'.repeat(openCurly - closeCurly);
  if (openBracket > closeBracket) s += ']'.repeat(openBracket - closeBracket);
  if (closeCurly > openCurly) {
    let excess = closeCurly - openCurly;
    while (excess > 0 && s.endsWith('}')) { s = s.slice(0, -1); excess--; }
  }
  return s !== raw.trim() ? s : null;
}

export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {}
): Promise<string> {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? false;
  let consecutiveGuardFailures = 0;
  let lastGuardErrors = '';
  const toolCallWindow: string[] = [];

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

    const guardResult = validateToolCalls(effectiveToolCalls);

    if (!guardResult.ok) {
      const errorKey = guardResult.errors.join('|');
      if (errorKey === lastGuardErrors) {
        consecutiveGuardFailures++;
      } else {
        consecutiveGuardFailures = 1;
        lastGuardErrors = errorKey;
      }

      if (consecutiveGuardFailures >= 3) {
        const normResult = normalizeToolCalls(effectiveToolCalls);
        if (normResult.fixed.length > 0) {
          if (debug) console.log(`[executor] Auto-repaired ${normResult.fixed.length} tool calls`);
          effectiveToolCalls.length = 0;
          effectiveToolCalls.push(...normResult.fixed);
          const repairedGuard = validateToolCalls(effectiveToolCalls);
          if (repairedGuard.ok) {
            consecutiveGuardFailures = 0;
          } else {
            throw new Error(
              `Tool call format correction failed after auto-repair. ` +
              `Original: ${guardResult.errors.join('; ')}. Fixed: ${repairedGuard.errors.join('; ')}`
            );
          }
        } else {
          throw new Error(
            `Tool call format correction failed after ${consecutiveGuardFailures} attempts. ` +
            `Errors: ${guardResult.errors.join('; ')}`
          );
        }
      }

      if (debug) {
        console.log(`[executor] Turn ${turn+1}: tool call validation FAILED (attempt ${consecutiveGuardFailures}/3):`, guardResult.errors);
      }

      const escalation = [
        '',
        `  FIX YOUR FORMAT. Use: {"name":"tool","arguments":{"key":"value"}}`,
        `  CRITICAL: Your tool calls are STILL broken. You MUST output PURE JSON with no XML tags, no markdown fences, no stringified arguments. Correct format: {"name":"tool_name","arguments":{"param":"value"}}`,
      ];
      messages.push({
        role: 'system',
        content: guardResult.correctionPrompt + (escalation[consecutiveGuardFailures - 1] || ''),
      });
      continue;
    }
    consecutiveGuardFailures = 0;

    for (const tc of guardResult.valid) {
      const key = `${tc.name}|${JSON.stringify(tc.arguments, Object.keys(tc.arguments || {}).sort())}`;
      toolCallWindow.push(key);
    }
    if (toolCallWindow.length > 25) toolCallWindow.splice(0, toolCallWindow.length - 25);

    for (const tc of guardResult.valid) {
      const key = `${tc.name}|${JSON.stringify(tc.arguments, Object.keys(tc.arguments || {}).sort())}`;
      if (toolCallWindow.filter(k => k === key).length >= 4) {
        messages.push({
          role: 'system',
          content: `LOOP DETECTED: You have called "${tc.name}" with the same arguments 4+ times. You are stuck. Provide your FINAL answer now — do NOT call any more tools.`,
        });
        if (debug) console.log(`[executor] Loop detected: ${key}`);
        break;
      }
    }

    const context: ToolContext = {
      messages,
      turn,
      model,
    };

    if (debug) {
      console.log(
        `[executor] Executing ${guardResult.valid.length} tool calls:`,
        guardResult.valid.map((tc) => tc.name)
      );
    }

    const toolResults = await executeToolCalls(guardResult.valid, context);

    messages.push(buildAssistantToolCallMessage(effectiveContent, guardResult.valid));

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