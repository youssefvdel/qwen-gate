/*
 * File: guard.ts
 * Tool call guard — validates tool calls before execution.
 * Rejects orphaned </tool_call>, malformed JSON, missing fields.
 * Generates correction prompts when validation fails.
 */

import type { ParsedToolCall } from './types.ts';

export interface GuardResult {
  /** Tool calls that passed validation */
  valid: ParsedToolCall[];
  /** Human-readable description of what went wrong */
  errors: string[];
  /** System prompt to send back to the model on the next turn */
  correctionPrompt: string;
  /** Whether all tool calls passed */
  ok: boolean;
}

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';

/**
 * Validate tool calls extracted from raw Qwen output.
 *
 * Checks performed:
 * 1. No orphaned </tool_call> — every closer must have a matching opener before it
 * 2. Every parsed tool call has a non-empty name
 * 3. Every parsed tool call has valid arguments (object, not string)
 * 4. Arguments is not empty (has at least one key)
 */
export function validateToolCalls(
  toolCalls: ParsedToolCall[],
  rawContent: string
): GuardResult {
  const errors: string[] = [];

  // ── Check 1: Orphaned </tool_call> ──────────────────────────────
  // Scan raw content for </tool_call> and verify each has a <tool_call> before it
  let closerCount = 0;
  let openCount = 0;
  let pos = 0;
  while (pos < rawContent.length) {
    const nextOpen = rawContent.indexOf(TOOL_START, pos);
    const nextClose = rawContent.indexOf(TOOL_END, pos);

    if (nextOpen === -1 && nextClose === -1) break;

    if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
      // </tool_call> appears before any <tool_call> — orphaned!
      closerCount++;
      pos = nextClose + TOOL_END.length;
    } else if (nextOpen !== -1) {
      openCount++;
      pos = nextOpen + TOOL_START.length;
    } else {
      pos = rawContent.length;
    }
  }
  // Also check: if total closers > openers, there are orphaned closers
  if (closerCount > openCount) {
    errors.push(`Found ${closerCount - openCount} orphaned </tool_call> tag(s) without matching <tool_call>. Each tool call must start with <tool_call> and end with </tool_call>.`);
  }

  // ── Check 2-4: Validate each parsed tool call ───────────────────
  for (const tc of toolCalls) {
    if (!tc.name || typeof tc.name !== 'string') {
      errors.push(`Tool call missing "name" field. Each tool call must have a valid "name".`);
    }
    if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) {
      errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments". Arguments must be a JSON object, not a string or array.`);
    }
    if (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments) && Object.keys(tc.arguments).length === 0) {
      errors.push(`Tool call "${tc.name}" has empty arguments object. Provide the required parameters.`);
    }
  }

  // ── Build correction prompt ─────────────────────────────────────
  let correctionPrompt = '';
  if (errors.length > 0) {
    correctionPrompt = `\n[SYSTEM: Tool call format correction required]\nThe previous response contained malformed tool calls. Fix these issues and retry:\n`;
    for (const err of errors) {
      correctionPrompt += `- ${err}\n`;
    }
    correctionPrompt += `\nRemember: Always wrap tool calls in <tool_call> and </tool_call> tags. Never output </tool_call> without <tool_call> before it. Use raw JSON inside the tags.`;
  }

  return {
    valid: errors.length === 0 ? toolCalls : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}
