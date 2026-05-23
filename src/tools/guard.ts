/*
 * File: guard.ts
 * Tool call guard — validates JSON tool calls before execution.
 * Rejects malformed JSON, missing fields, invalid arguments.
 * Generates correction prompts when validation fails.
 */

import type { ParsedToolCall } from './types.ts';

export interface GuardResult {
  valid: ParsedToolCall[];
  errors: string[];
  correctionPrompt: string;
  ok: boolean;
}

export interface ProviderToolLeakResult {
  detected: boolean;
  reason?: string;
  type?: 'function_role' | 'tool_call_role' | 'tool_not_exists' | 'tool_use_xml' | 'function_call_json';
  toolName?: string;
}

export function checkProviderToolLeak(content: string, role?: string): ProviderToolLeakResult {
  const PROVIDER_TOOL_LEAK_ROLES = ['function', 'tool_call'];
  if (role && PROVIDER_TOOL_LEAK_ROLES.includes(role)) {
    return { detected: true, reason: `Provider returned role=${role}`, type: role as 'function_role' | 'tool_call_role' };
  }
  if (!content) return { detected: false };
  if (/<tool_use>[\s\S]*?<\/tool_use>/i.test(content)) return { detected: true, reason: 'Provider emitted <tool_use> XML format', type: 'tool_use_xml' };
  if (/"function":\s*\{[^}]*"name":\s*"[^"]+"/i.test(content)) return { detected: true, reason: 'Provider emitted function_call JSON format', type: 'function_call_json' };
  return { detected: false };
}

export function validateToolCalls(toolCalls: ParsedToolCall[]): GuardResult {
  const errors: string[] = [];
  for (const tc of toolCalls) {
    if (!tc.name || typeof tc.name !== 'string') errors.push(`Tool call missing "name" field.`);
    if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments".`);
    if (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments) && Object.keys(tc.arguments).length === 0) errors.push(`Tool call "${tc.name}" has empty arguments object.`);
  }
  const correctionPrompt = errors.length > 0
    ? `\n[SYSTEM: Tool call format correction required]\n${errors.map(e => `- ${e}`).join('\n')}\nAlways output tool calls as raw JSON with no surrounding text.`
    : '';
  return { valid: errors.length === 0 ? toolCalls : [], errors, correctionPrompt, ok: errors.length === 0 };
}

export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors: string[] = [];
  if (!tc.name || typeof tc.name !== 'string' || tc.name.trim() === '') errors.push(`Tool call missing or empty "name" field.`);
  if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments".`);
  const correctionPrompt = errors.length > 0
    ? `[SYSTEM: Tool call format error]\n${errors.map(e => `- ${e}`).join('\n')}\nPlease fix the format and retry. Use JSON: {"name": "tool_name", "arguments": {"param": "value"}}`
    : '';
  return { valid: errors.length === 0 ? [tc] : [], errors, correctionPrompt, ok: errors.length === 0 };
}