/*
 * File: guard.ts
 * Tool call guard — validates tool calls before execution.
 * Rejects orphaned </tool_call>, malformed JSON, missing fields.
 * Generates correction prompts when validation fails.
 *
 * Enhanced with Luna-Proxy patterns:
 * - Provider tool leak detection (function_role, tool_not_exists, etc.)
 * - Chinese/English error message leak blocking
 * - CDATA-aware parsing helpers
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

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';

const TOOL_NOT_EXISTS_PATTERNS = [
  /Tool\s+\w+\s+does\s+not\s+(?:exist|exists)/i,
  /tool\s+['\u2018\u2019"]?\w+['\u2019"]?\s+(?:is\s+)?(?:not\s+)?(?:found|unavailable|unknown|not\s+supported)/i,
  /Function\s+\w+\s+(?:is\s+)?(?:not\s+)?(?:found|unavailable|unknown)/i,
  /No\s+(?:tool|function)\s+(?:named|called)\s+['\u2018\u2019"]?\w+/i,
  /I\s+(?:do not|don't|cannot?)\s+(?:have|possess|use)\s+(?:a\s+)?(?:tool|function)/i,
];

const LEAK_PATTERNS = [
  /直接聊天/i,
  /无法访问该链接/i,
  /用户使用了工具，但未能成功执行/i,
  /Tool does not exist/i,
  /Function .* is not found/i,
  /I (do not|don't|cannot?) (?:have|possess|use) (?:a )?(?:tool|function)/i,
  /tool resources exhausted/i,
];

export function checkProviderToolLeak(content: string, role?: string): ProviderToolLeakResult {
  const PROVIDER_TOOL_LEAK_ROLES = ['function', 'tool_call'];
  if (role && PROVIDER_TOOL_LEAK_ROLES.includes(role)) {
    return { detected: true, reason: `Provider returned role=${role}`, type: role as 'function_role' | 'tool_call_role' };
  }
  if (!content) return { detected: false };
  for (const pattern of TOOL_NOT_EXISTS_PATTERNS) {
    const match = content.match(pattern);
    if (match) return { detected: true, reason: `Provider tool error: ${match[0].slice(0, 120)}`, type: 'tool_not_exists' };
  }
  if (/<tool_use>[\s\S]*?<\/tool_use>/i.test(content)) return { detected: true, reason: 'Provider emitted <tool_use> XML format', type: 'tool_use_xml' };
  if (/"function":\s*\{[^}]*"name":\s*"[^"]+"/i.test(content)) return { detected: true, reason: 'Provider emitted function_call JSON format', type: 'function_call_json' };
  return { detected: false };
}

export function isToolNotFoundMessage(content: string): boolean {
  return TOOL_NOT_EXISTS_PATTERNS.some(p => p.test(content));
}

export function hasChineseLeak(text: string): boolean {
  return LEAK_PATTERNS.some(p => p.test(text));
}

export function cleanVisibleChunk(text: string): string {
  if (!text) return '';
  return text
    .replace(/<\/?(?:tool_calls|tool_call|tool_name|parameters|ml_tool_calls|ml_tool_call|ml_tool_name|ml_parameters|ml_tool_result)>/g, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<ml_tool_result>[\s\S]*?<\/ml_tool_result>/gi, '')
    .replace(/<![CDATA\[[\s\S]*?\]\]>/g, '');
}

export function cleanVisibleText(text: string): string {
  if (!text) return '';
  let cleaned = text
    .replace(/<ml_tool_calls>[\s\S]*?<\/ml_tool_calls>/g, '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
    .replace(/<ml_tool_call>[\s\S]*?<\/ml_tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '')
    .replace(/<tool_use_result>[\s\S]*?<\/tool_use_result>/g, '')
    .replace(/<ml_tool_result>[\s\S]*?<\/ml_tool_result>/g, '')
    .replace(/<\/?(?:ml_tool_calls|ml_tool_call|ml_tool_name|ml_parameters|ml_tool_result|tool_calls|tool_call|tool_name|parameters)>/g, '')
    .replace(/<![CDATA\[[\s\S]*?\]\]>/g, '');
  for (const pattern of LEAK_PATTERNS) cleaned = cleaned.replace(pattern, '');
  return cleaned.trim();
}

export function extractCdataContent(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function tryParseJsonValue(val: string): any {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    !isNaN(Number(trimmed))
  ) {
    try { return JSON.parse(trimmed); } catch { return val; }
  }
  return val;
}

export function validateToolCalls(toolCalls: ParsedToolCall[], rawContent: string): GuardResult {
  const errors: string[] = [];
  let closerCount = 0, openCount = 0, pos = 0;
  while (pos < rawContent.length) {
    const nextOpen = rawContent.indexOf(TOOL_START, pos);
    const nextClose = rawContent.indexOf(TOOL_END, pos);
    if (nextOpen === -1 && nextClose === -1) break;
    if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) { closerCount++; pos = nextClose + TOOL_END.length; }
    else if (nextOpen !== -1) { openCount++; pos = nextOpen + TOOL_START.length; }
    else { pos = rawContent.length; }
  }
  if (closerCount > openCount) errors.push(`Found ${closerCount - openCount} orphaned </tool_call> tag(s) without matching <tool_call>.`);
  for (const tc of toolCalls) {
    if (!tc.name || typeof tc.name !== 'string') errors.push(`Tool call missing "name" field.`);
    if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments".`);
    if (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments) && Object.keys(tc.arguments).length === 0) errors.push(`Tool call "${tc.name}" has empty arguments object.`);
  }
  const correctionPrompt = errors.length > 0
    ? `\n[SYSTEM: Tool call format correction required]\n${errors.map(e => `- ${e}`).join('\n')}\nAlways wrap tool calls in <tool_call> and </tool_call> tags.`
    : '';
  return { valid: errors.length === 0 ? toolCalls : [], errors, correctionPrompt, ok: errors.length === 0 };
}

export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors: string[] = [];
  if (!tc.name || typeof tc.name !== 'string' || tc.name.trim() === '') errors.push(`Tool call missing or empty "name" field.`);
  if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments".`);
  const correctionPrompt = errors.length > 0
    ? `[SYSTEM: Tool call format error]\n${errors.map(e => `- ${e}`).join('\n')}\nPlease fix the format and retry. Use <tool_call> tags with raw JSON inside.`
    : '';
  return { valid: errors.length === 0 ? [tc] : [], errors, correctionPrompt, ok: errors.length === 0 };
}