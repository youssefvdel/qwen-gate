/*
 * File: guard.ts
 * Tool call guard — validates JSON tool calls before execution.
 * Rejects malformed JSON, missing fields, invalid arguments.
 * Detects provider tool leak patterns (XML tags, function_call format).
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
  type?: 'function_role' | 'tool_call_role' | 'tool_not_exists' | 'tool_use_xml' | 'function_call_json' | 'orphaned_tag' | 'mixed_format';
  toolName?: string;
}

// ─── Provider Tool Leak Detection ──────────────────────────────────────────────

/** XML tags that indicate the provider is leaking its native tool format */
const TOOL_LEAK_XML_PATTERNS: Array<{ pattern: RegExp; description: string; type: ProviderToolLeakResult['type'] }> = [
  { pattern: /<tool_use>[\s\S]*?<\/tool_use>/i, description: 'Provider emitted <tool_use> XML format', type: 'tool_use_xml' },
  { pattern: /<tool_call>[\s\S]*?<\/tool_call>/i, description: 'Provider emitted XML format', type: 'tool_use_xml' },
  { pattern: /<function_call>[\s\S]*?<\/function_call>/i, description: 'Provider emitted <function_call> XML format', type: 'function_call_json' },
  { pattern: /<function_calls>[\s\S]*?<\/function_calls>/i, description: 'Provider emitted <function_calls> XML format', type: 'function_call_json' },
];

/** Orphaned/incomplete XML tags that suggest partial format leaks */
const ORPHANED_TAG_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /<\/?tool_use\s*>/i, description: 'Orphaned tag detected' },
  { pattern: /<\/?tool_call\s*>/i, description: 'Orphaned <tool_call> tag detected' },
  { pattern: /<\/?function_call\s*>/i, description: 'Orphaned <function_call> tag detected' },
  { pattern: /<\/?function_calls\s*>/i, description: 'Orphaned <function_calls> tag detected' },
  { pattern: /<\/?tools?\s*>/i, description: 'Orphaned <tool(s)> tag detected' },
];

/** Roles that indicate the provider returned a tool-specific role instead of 'assistant' */
const PROVIDER_TOOL_LEAK_ROLES = ['function', 'tool_call', 'tool_use'];

/**
 * Detect if the provider leaked its native tool calling format into the response.
 * This catches cases where the upstream provider (Anthropic, etc.) emits
 * XML-wrapped tool calls instead of plain JSON.
 */
export function checkProviderToolLeak(content: string, role?: string): ProviderToolLeakResult {
  // Check role-based leaks
  if (role && PROVIDER_TOOL_LEAK_ROLES.includes(role)) {
    return {
      detected: true,
      reason: `Provider returned role=${role} instead of 'assistant'`,
      type: role as 'function_role' | 'tool_call_role',
    };
  }

  if (!content) return { detected: false };

  // Check complete XML tool patterns
  for (const { pattern, description, type } of TOOL_LEAK_XML_PATTERNS) {
    if (pattern.test(content)) {
      return { detected: true, reason: description, type };
    }
  }

  // Check function_call JSON format (OpenAI legacy)
  if (/"function"\s*:\s*\{[^}]*"name"\s*:\s*"[^"]+"/i.test(content)) {
    return {
      detected: true,
      reason: 'Provider emitted function_call JSON format',
      type: 'function_call_json',
    };
  }

  // Check for orphaned/incomplete tags
  for (const { pattern, description } of ORPHANED_TAG_PATTERNS) {
    if (pattern.test(content)) {
      return {
        detected: true,
        reason: description,
        type: 'orphaned_tag',
      };
    }
  }

  // Check for mixed format (both XML tags and JSON tool calls in same response)
  const hasXmlTags = /<(?:tool_use|tool_call|function_call)/i.test(content);
  const hasJsonToolCalls = /\{\s*"name"\s*:/i.test(content);
  if (hasXmlTags && hasJsonToolCalls) {
    return {
      detected: true,
      reason: 'Response contains both XML tool tags and JSON tool calls (mixed format)',
      type: 'mixed_format',
    };
  }

  return { detected: false };
}

// ─── Tool Call Validation ──────────────────────────────────────────────────────

/** Tool name validation pattern: alphanumeric, underscores, hyphens, dots */
const VALID_TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.:-]*$/;

/** Maximum allowed tool name length */
const MAX_TOOL_NAME_LENGTH = 128;

/** Maximum allowed argument depth (to prevent stack overflow) */
const MAX_ARGUMENT_DEPTH = 32;

/**
 * Validate a single tool call.
 */
function validateSingleTC(tc: ParsedToolCall): string[] {
  const errors: string[] = [];

  // Name validation
  if (!tc.name || typeof tc.name !== 'string') {
    errors.push(`Tool call missing "name" field.`);
  } else {
    const trimmed = tc.name.trim();
    if (!trimmed) {
      errors.push(`Tool call has empty "name" field.`);
    } else if (trimmed.length > MAX_TOOL_NAME_LENGTH) {
      errors.push(`Tool call name "${trimmed.substring(0, 50)}..." exceeds maximum length of ${MAX_TOOL_NAME_LENGTH}.`);
    } else if (!VALID_TOOL_NAME_PATTERN.test(trimmed)) {
      errors.push(`Tool call name "${trimmed}" contains invalid characters. Use alphanumeric, underscores, hyphens, dots.`);
    }
  }

  // Arguments validation
  if (!tc.arguments || typeof tc.arguments !== 'object' || Array.isArray(tc.arguments)) {
    errors.push(`Tool call "${tc.name || 'unknown'}" has invalid "arguments" (must be a JSON object).`);
  } else {
    // Check for excessively deep nesting
    const depth = measureDepth(tc.arguments);
    if (depth > MAX_ARGUMENT_DEPTH) {
      errors.push(`Tool call "${tc.name}" arguments are nested too deeply (${depth} levels, max ${MAX_ARGUMENT_DEPTH}).`);
    }

    // Check for undefined values (common LLM mistake)
    const undefinedKeys = findUndefinedValues(tc.arguments);
    if (undefinedKeys.length > 0) {
      errors.push(`Tool call "${tc.name}" has undefined values for: ${undefinedKeys.join(', ')}. Use null instead.`);
    }
  }

  return errors;
}

/**
 * Validate an array of tool calls (batch validation).
 */
export function validateToolCalls(toolCalls: ParsedToolCall[]): GuardResult {
  const errors: string[] = [];
  const valid: ParsedToolCall[] = [];

  if (!Array.isArray(toolCalls)) {
    errors.push('Tool calls must be an array.');
    return { valid: [], errors, correctionPrompt: buildCorrectionPrompt(errors), ok: false };
  }

  if (toolCalls.length === 0) {
    return { valid: [], errors: [], correctionPrompt: '', ok: true };
  }

  // Check for duplicate IDs
  const seenIds = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.id && seenIds.has(tc.id)) {
      errors.push(`Duplicate tool call ID: "${tc.id}".`);
    }
    if (tc.id) seenIds.add(tc.id);
  }

  // Validate each tool call
  for (const tc of toolCalls) {
    const tcErrors = validateSingleTC(tc);
    if (tcErrors.length === 0) {
      // Normalize the name (trim whitespace)
      valid.push({ ...tc, name: tc.name.trim() });
    } else {
      errors.push(...tcErrors);
    }
  }

  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? valid : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

/**
 * Validate a single tool call (public API for individual validation).
 */
export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors = validateSingleTC(tc);
  const correctionPrompt = errors.length > 0
    ? `[SYSTEM: Tool call format error]\n${errors.map(e => `- ${e}`).join('\n')}\nPlease fix the format and retry. Use JSON: {"name": "tool_name", "arguments": {"param": "value"}}`
    : '';
  return {
    valid: errors.length === 0 ? [{ ...tc, name: tc.name.trim() }] : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildCorrectionPrompt(errors: string[]): string {
  return [
    '\n[SYSTEM: Tool call format correction required]',
    ...errors.map(e => `- ${e}`),
    'Always output tool calls as raw JSON: {"name": "tool_name", "arguments": {"param": "value"}}',
    'Multiple tool calls should be separate JSON objects, not wrapped in XML or markdown.',
  ].join('\n');
}

function measureDepth(value: unknown, current = 0): number {
  if (current > MAX_ARGUMENT_DEPTH) return current;
  if (value === null || value === undefined) return current;
  if (typeof value !== 'object') return current;

  const nextDepth = current + 1;
  if (Array.isArray(value)) {
    let max = nextDepth;
    for (const item of value) {
      max = Math.max(max, measureDepth(item, nextDepth));
    }
    return max;
  }

  let max = nextDepth;
  for (const val of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, measureDepth(val, nextDepth));
  }
  return max;
}

function findUndefinedValues(obj: Record<string, unknown>, prefix = ''): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) {
      result.push(path);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...findUndefinedValues(value as Record<string, unknown>, path));
    }
  }
  return result;
}
