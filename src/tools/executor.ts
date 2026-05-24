/*
 * File: executor.ts
 * Project: qwen-gate
 * Execution loop for tool calling — agentic loop that handles
 * send -> tool calls -> execute -> re-send until completion.
 *
 * Features:
 * - Bounded parallel execution with configurable concurrency
 * - Per-tool timeout handling
 * - Error aggregation with partial failure support
 * - Auto-repair of malformed tool calls after repeated guard failures
 * - Tool call deduplication detection
 */

import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall, ToolCallResult, ToolContext } from './types.ts';
import { SchemaValidationError } from './schema.ts';
import { registry } from './registry.ts';
import { robustParseJSON } from '../utils/json.ts';
import { validateToolCalls } from './guard.ts';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface ExecutionLoopConfig {
  maxTurns?: number;
  debug?: boolean;
  /** Maximum number of tools to execute in parallel (default: 10) */
  maxConcurrency?: number;
  /** Per-tool execution timeout in milliseconds (default: 30000 = 30s) */
  toolTimeoutMs?: number;
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

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENCY = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_GUARD_RETRIES = 3;

// ─── Content Parsing ───────────────────────────────────────────────────────────

/**
 * Extract tool calls embedded in free-form text content.
 * LLMs sometimes emit JSON tool calls directly in the content field
 * instead of using the structured tool_calls API.
 */
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

    // Search backward for opening brace (within reasonable distance)
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

    const after = remaining.substring(braceIdx);
    const jsonEnd = findBalancedJsonEnd(after);

    if (jsonEnd === -1) {
      textContent += remaining;
      break;
    }

    const jsonStr = after.substring(0, jsonEnd);

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

    remaining = after.substring(jsonEnd);
  }

  return { textContent: textContent.trim(), toolCalls };
}

/**
 * Find the end of a balanced JSON object/array in a string.
 * Returns -1 if the structure is unbalanced.
 */
function findBalancedJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// ─── Tool Execution ────────────────────────────────────────────────────────────

/**
 * Execute a single tool call with timeout protection.
 */
async function executeSingleTool(
  tc: ParsedToolCall,
  context: ToolContext,
  timeoutMs: number
): Promise<ToolCallResult> {
  if (!registry.has(tc.name)) {
    return {
      toolCallId: tc.id,
      name: tc.name,
      result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
      isError: true,
    };
  }

  try {
    // Race the tool execution against a timeout
    const result = await Promise.race([
      registry.execute(tc.name, tc.arguments, context),
      createTimeout(timeoutMs, tc.name),
    ]);

    return {
      toolCallId: tc.id,
      name: tc.name,
      result,
      isError: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isValidation = err instanceof SchemaValidationError;
    const isTimeout = message.startsWith('Tool execution timed out');

    return {
      toolCallId: tc.id,
      name: tc.name,
      result: JSON.stringify({
        error: isTimeout
          ? 'Tool execution timed out'
          : isValidation
            ? 'Schema validation failed'
            : 'Tool execution error',
        details: message,
        ...(isValidation ? { path: (err as SchemaValidationError).path } : {}),
      }),
      isError: true,
    };
  }
}

function createTimeout(ms: number, toolName: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms for '${toolName}'`)), ms);
  });
}

/**
 * Execute multiple tool calls with bounded concurrency.
 * Instead of unbounded Promise.all, uses a semaphore-like approach
 * to limit the number of concurrent executions.
 */
export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS
): Promise<ToolCallResult[]> {
  if (toolCalls.length === 0) return [];

  // For small batches, just run all in parallel
  if (toolCalls.length <= maxConcurrency) {
    return await Promise.all(
      toolCalls.map(tc => executeSingleTool(tc, context, timeoutMs))
    );
  }

  // Bounded concurrency using a queue
  const results: ToolCallResult[] = new Array(toolCalls.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < toolCalls.length) {
      const idx = nextIndex++;
      results[idx] = await executeSingleTool(toolCalls[idx], context, timeoutMs);
    }
  }

  // Launch workers up to maxConcurrency
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(maxConcurrency, toolCalls.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ─── Message Builders ──────────────────────────────────────────────────────────

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

// ─── Tool Call Repair ──────────────────────────────────────────────────────────

/**
 * Attempt to auto-repair malformed tool calls.
 * Fixes: stringified arguments, broken JSON, whitespace issues.
 */
function normalizeToolCalls(toolCalls: ParsedToolCall[]): { fixed: ParsedToolCall[] } {
  const fixed: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    try {
      let args = tc.arguments;
      if (typeof args === 'string') {
        const argStr: string = args;
        try {
          args = JSON.parse(argStr);
        } catch {
          const repaired = repairJson(argStr);
          if (repaired) {
            try { args = JSON.parse(repaired); } catch { continue; }
          } else {
            continue;
          }
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

/**
 * Attempt to repair common JSON malformations from LLM output.
 */
function repairJson(raw: string): string | null {
  if (!raw || raw.trim().length < 2) return null;
  let s = raw.trim();

  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Balance braces and brackets
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
  if (closeBracket > openBracket) {
    let excess = closeBracket - openBracket;
    while (excess > 0 && s.endsWith(']')) { s = s.slice(0, -1); excess--; }
  }

  return s !== raw.trim() ? s : null;
}

// ─── Execution Loop ────────────────────────────────────────────────────────────

/**
 * Run the agentic execution loop.
 * Sends messages to the LLM, processes tool calls, feeds results back,
 * and repeats until the LLM produces a final text response or max turns reached.
 */
export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {}
): Promise<string> {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? false;
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

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

    // ── Guard Validation ──────────────────────────────────────────────
    const guardResult = validateToolCalls(effectiveToolCalls);

    if (!guardResult.ok) {
      const errorKey = guardResult.errors.join('|');
      if (errorKey === lastGuardErrors) {
        consecutiveGuardFailures++;
      } else {
        consecutiveGuardFailures = 1;
        lastGuardErrors = errorKey;
      }

      if (consecutiveGuardFailures >= MAX_GUARD_RETRIES) {
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
        console.log(`[executor] Turn ${turn+1}: tool call validation FAILED (attempt ${consecutiveGuardFailures}/${MAX_GUARD_RETRIES}):`, guardResult.errors);
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

    // ── Duplicate Detection ────────────────────────────────────────────
    for (const tc of guardResult.valid) {
      const key = `${tc.name}|${JSON.stringify(tc.arguments)}`;
      toolCallWindow.push(key);
      if (toolCallWindow.length > 20) toolCallWindow.shift();
    }

    const recentCount = toolCallWindow.slice(-10).length;
    const uniqueRecent = new Set(toolCallWindow.slice(-10)).size;
    if (recentCount > 3 && uniqueRecent <= 2) {
      if (debug) console.log('[executor] Detected potential tool call loop');
      messages.push({
        role: 'system',
        content: '[SYSTEM: You appear to be calling the same tools repeatedly without progress. Please vary your approach or provide a text response.]',
      });
    }

    // ── Execute Tool Calls ─────────────────────────────────────────────
    messages.push(buildAssistantToolCallMessage(effectiveContent, guardResult.valid));

    const toolResults = await executeToolCalls(
      guardResult.valid,
      { messages, turn, model },
      maxConcurrency,
      toolTimeoutMs
    );

    // Aggregate results and report errors
    const errorResults = toolResults.filter(r => r.isError);
    if (debug && errorResults.length > 0) {
      console.log(`[executor] ${errorResults.length}/${toolResults.length} tool calls failed`);
    }

    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }
  }

  // Max turns reached
  if (debug) {
    console.log(`[executor] Max turns (${maxTurns}) reached`);
  }
  return `[Execution loop reached maximum turns (${maxTurns}). Please provide a final response.]`;
}
