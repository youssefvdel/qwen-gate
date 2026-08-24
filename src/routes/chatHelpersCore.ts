import { logStore } from '../services/logStore.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { TOOL_CALL_KEYWORDS, TOOL_RESULT_KEYWORDS } from '../utils/tagNames.ts';
import { QWEN_THINK_TAG_PATTERN as THINK_TAG_PATTERN } from '../utils/thinkTagStripper.ts';

// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return '';
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return '';
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export function detectCumulativeChunk(newText: string, lastText: string): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };
  if (newText === lastText) return { cumulative: false, delta: '' };

  // Fast path: exact prefix match
  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  // Fingerprint-based recovery: Qwen sometimes resends cumulative content
  // with minor edits (extra words, rephrasing). Use suffix fingerprints to
  // find where old content resumes in the new text.
  if (newText.length > lastText.length && lastText.length >= 32) {
    // Try multiple fingerprint sizes for robustness
    for (const fpSize of [64, 48, 32, 24]) {
      if (lastText.length < fpSize) continue;
      const fingerprint = lastText.slice(-fpSize);
      const idx = newText.indexOf(fingerprint);
      if (idx === -1) continue;

      const expectedEnd = idx + lastText.length;
      if (expectedEnd > newText.length) continue;

      // Check if the found position is plausible: the overlap region at
      // expectedEnd should match the tail of lastText by at least 75%.
      const overlap = newText.substring(expectedEnd - Math.min(20, lastText.length), expectedEnd);
      const lastTail = lastText.slice(-overlap.length);
      const overlapMatch = commonSuffixLen(overlap, lastTail);
      if (overlapMatch < overlap.length * 0.75 && overlapMatch < 3) continue;

      const delta = newText.substring(expectedEnd);
      if (delta) {
        return { cumulative: true, delta };
      }
    }
  }

  return { cumulative: false, delta: newText };
}

export function getSnapshotDelta(newSnapshot: string, lastSnapshot: string): string {
  if (!newSnapshot) return '';
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return '';

  // Fast path: monotonic growth (the common case)
  if (newSnapshot.length > lastSnapshot.length && newSnapshot.startsWith(lastSnapshot)) return newSnapshot.substring(lastSnapshot.length);

  // When cleaning removes characters (e.g. partial <tool_call completing to
  // <tool_call> which then gets stripped by cleanThinkTags), newSnapshot can
  // be SHORTER than lastSnapshot. Use common prefix to find what's genuinely new.
  // Also handles the case where previous content was re-cleaned more aggressively.
  const prefixLen = commonPrefixLen(newSnapshot, lastSnapshot);
  if (prefixLen > 0 && prefixLen < newSnapshot.length) {
    return newSnapshot.substring(prefixLen);
  }
  if (prefixLen === newSnapshot.length && prefixLen > 0) {
    // newSnapshot is entirely a prefix of lastSnapshot — nothing genuinely new
    return '';
  }

  // Fallback: fingerprint-based cumulative chunk detection for overlapping content
  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;
  return '';
}

/** Matches tool result tag fragments (requires closing > to avoid false stripping of /toolbox /toolkit etc). */
const TOOL_RESULT_TAG_PATTERN = new RegExp(`<\\/${TOOL_RESULT_KEYWORDS.join('|')}>`, 'gi');

/**
 * Data-driven regex builder for tool call XML tag & tail stripping.
 * Qwen's tool call format uses `<keyword=value>` and `</keyword>` patterns
 * where keyword is known (function, parameter). The SSE tokenizer can split
 * these at arbitrary byte boundaries (e.g., `<func` + `tion=name>`).
 *
 * Instead of hardcoding every possible split, we generate regexes from the
 * known keywords, computing:
 *  - Tag prefixes: all substrings ≥ MIN chars (handles chunk-boundary splits)
 *  - Continuation tails: what survives after the prefix was stripped
 *
 * Add new keywords to the array when Qwen's tool call format changes.
 */
const MIN_TOOL_PREFIX_LEN = 3;
const [TOOL_TAG_RE] = (() => {
  const keywords = TOOL_CALL_KEYWORDS;
  const tagPrefixes: string[] = [];

  for (const kw of keywords) {
    for (let i = MIN_TOOL_PREFIX_LEN; i <= kw.length; i++) {
      const p = kw.slice(0, i);
      tagPrefixes.push(p); // fun, funct, ..., /fun, /funct, ...
      tagPrefixes.push('/' + p);
    }
  }

  tagPrefixes.sort((a, b) => b.length - a.length);
  const tagRe = new RegExp(`<(?:${tagPrefixes.join('|')})[^>]*(?:>|$)`, 'gi');
  return [tagRe];
})();

export function cleanThinkTags(t: string): string {
  // Fast path: skip all regex work when there's no tag-like content or tail fragment
  // `>` is included because `word>` at line start (from `</keyword>` split) needs stripping
  if (!t.includes('<') && !t.includes('=') && !t.includes('>')) return t;
  let s = t.replace(THINK_TAG_PATTERN, '');
  s = s.replace(TOOL_RESULT_TAG_PATTERN, '');
  // Strip tool call XML tags (complete + partial at chunk boundaries)
  s = s.replace(TOOL_TAG_RE, '');
  // Generic chunk-boundary artifact cleanup: works for ANY XML-like output from any AI,
  // not just known tool call keywords. Covers all fragment types that LLM tokenizers can
  // produce at arbitrary split points:
  //
  //   A. `=name>` at line start: `<keyword=name>` splits as `<keyword` + `=name>`.
  //   B. `tail=name>` at line start: `<keyword=name>` splits as `<key` + `word=name>`
  //      (e.g. `ction=filePath>` when the first 3 chars `fun` are in the previous chunk).
  //   C. `</` at end of string: `</keyword>` splits as `...</` + `keyword>`.
  //   D. `<` at end of string: `<keyword>` splits as `...<` + `keyword>`.
  //   E. `word>` at line start (from `</keyword>` split across chunks: `</` + `keyword>`).
  s = s.replace(/^=[^\s>]+>/gm, ''); // =name> continuation
  s = s.replace(/^[a-z]+=[^\s>]+>/gm, ''); // tail=name> continuation (generic, no keyword knowledge needed)
  s = s.replace(/^[a-z]{3,}>/gm, ''); // word> at line start (e.g. `function>` after `</` was stripped)
  s = s.replace(/<\/(?=$)/g, ''); // </ at end of string
  s = s.replace(/<$/g, ''); // < at end of string
  return s;
}

export { compressToolResult, truncateToolResult } from './compressToolResult.ts';

// ── Tool and streaming utilities ──────────────────────────────────

export class ToolSpamGuard {
  private window: number;
  private threshold: number;
  private history: Array<{ key: string }>;

  constructor(window = 8, threshold = 2) {
    this.window = window;
    this.threshold = threshold;
    this.history = [];
  }

  private canonicalize(args: any): any {
    if (typeof args !== 'object' || args === null) return args;
    if (Array.isArray(args)) return args.map((a) => this.canonicalize(a));
    return Object.keys(args)
      .sort()
      .reduce((acc: any, key) => {
        acc[key] = this.canonicalize(args[key]);
        return acc;
      }, {});
  }

  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter((h) => h.key === key).length + 1;
    this.history.push({ key });
    if (this.history.length > this.window * 2) this.history = this.history.slice(-this.window);
    if (count > this.threshold) {
      return {
        ok: false,
        correctionPrompt:
          `[TOOL SPAM] Called "${tool}" with identical arguments ${count} times in the last ${this.window} calls. ` +
          `Stop repeating this call. Analyze the results you already have and respond to the user. ` +
          `Do NOT call "${tool}" again with the same arguments.`,
      };
    }
    return { ok: true };
  }
}

export const pendingCorrections = new Map<string, string[]>();

// Prevent unbounded growth: trim oldest entries every 5 minutes
const MAX_PENDING_CORRECTIONS = 500;
setInterval(
  () => {
    if (pendingCorrections.size > MAX_PENDING_CORRECTIONS) {
      const toDelete = pendingCorrections.size - MAX_PENDING_CORRECTIONS;
      let i = 0;
      for (const key of pendingCorrections.keys()) {
        if (i >= toDelete) break;
        pendingCorrections.delete(key);
        i++;
      }
    }
  },
  5 * 60 * 1000,
).unref();

export function parseQwenErrorPayload(raw: string): {
  message: string;
  status: import('hono/utils/http-status').ContentfulStatusCode;
  /** Upstream error code, e.g. RateLimited / Not_Found / UpstreamError */
  code?: string;
  /** Hours Qwen asked to wait (RateLimited payloads carry data.num) */
  waitHours?: number;
} | null {
  let text = raw.trim();
  if (!text) return null;
  // Strip SSE data: prefix if present — used when checking full buffer content
  if (text.startsWith('data: ')) text = text.slice(6).trim();
  // Skip SSE control lines and [DONE]
  if (text === '[DONE]' || text.startsWith(':')) return null;
  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : code === 'Not_Found' ? 404 : 502;
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status, code, waitHours: payload.data?.num };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return null;
  }
  return null;
}

export interface DeltaContentResult {
  vStr: string;
  foundStr: boolean;
  isThinkingChunk: boolean;
  currentThoughtIndex: number;
}

export function extractDeltaContent(
  chunk: any,
  targetResponseId: string | null,
  currentThoughtIndex: number,
  reasoningBuffer: string,
): DeltaContentResult {
  let vStr = '';
  let foundStr = false;
  let isThinkingChunk = false;
  let newThoughtIndex = currentThoughtIndex;

  if (
    chunk.choices &&
    chunk.choices[0] &&
    chunk.choices[0].delta &&
    (targetResponseId === null || chunk.response_id === targetResponseId || chunk['response.created']?.response_id === targetResponseId)
  ) {
    const delta = chunk.choices[0].delta;
    if (delta.phase === 'thinking_summary') {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
        if (rawNew) {
          const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
          vStr = rawNew.substring(commonLen);
          if (vStr) {
            newThoughtIndex = thoughts.length;
            foundStr = true;
          }
        }
      }
    } else if (delta.phase === 'think') {
      isThinkingChunk = true;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.phase === 'answer') {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.reasoning_content !== undefined && delta.reasoning_content) {
      // OpenAI-compatible format (no phase field): reasoning_content for thinking
      isThinkingChunk = true;
      vStr = delta.reasoning_content;
      if (vStr) foundStr = true;
    } else if (delta.content !== undefined && delta.content && !delta.phase) {
      // OpenAI-compatible format (no phase field): content for answer
      isThinkingChunk = false;
      vStr = delta.content;
      if (vStr) foundStr = true;
    }
  }
  return { vStr, foundStr, isThinkingChunk, currentThoughtIndex: newThoughtIndex };
}

export interface ToolCallProcessingOptions {
  label?: string;
  logParsed?: boolean;
  logId: string;
  toolSpamGuard: ToolSpamGuard;
  correctionPrompts: string[];
  maxToolCalls: number;
}

export function processToolCallsThroughGuard(toolCalls: any[], toolCallsOut: any[], options: ToolCallProcessingOptions): void {
  const { label, logParsed = false, logId, toolSpamGuard, correctionPrompts, maxToolCalls } = options;
  const effectiveMax = maxToolCalls ?? 8;

  if (toolCalls.length > effectiveMax) {
    logStore.log(
      'debug',
      'chat',
      `  [🛑 TOOL LIMIT${label ? ' ' + label : ''}] Truncating ${toolCalls.length} tool calls to first ${effectiveMax}`,
    );
    toolCalls = toolCalls.slice(0, effectiveMax);
  }

  for (const tc of toolCalls) {
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      correctionPrompts.push(guard.correctionPrompt);
      continue;
    }
    const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
    if (!spamCheck.ok) {
      logStore.log('debug', 'chat', `  [🛑 TOOL SPAM${label ? ' ' + label : ''}] ${tc.name}: repeated call blocked`);
      correctionPrompts.push(spamCheck.correctionPrompt);
      continue;
    }
    if (toolCallsOut.length >= maxToolCalls) {
      logStore.log(
        'debug',
        'chat',
        `  [🛑 TOOL LIMIT${label ? ' ' + label : ''}] Hit ${maxToolCalls} tool calls per turn, dropping excess`,
      );
      correctionPrompts.push(
        `[TOOL CALL LIMIT] Reached maximum of ${maxToolCalls} tool calls per turn. Analyze existing results and respond to the user.`,
      );
      break;
    }
    toolCallsOut.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    });
    if (logParsed) {
      logStore.updateEntry(logId, (entry: any) => {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
    }
  }
}

export interface AmplificationGuardState {
  rawInputBytes: number;
  emittedOutputBytes: number;
  triggered: boolean;
}

export function checkAmplificationGuard(
  state: AmplificationGuardState,
  newOutputLen: number,
  logId: string,
  resolvedEmail: string,
  model: string,
  lastRawContent: string,
  lastVStrRaw: string,
): boolean {
  if (!state.triggered) {
    const projectedRatio = (state.emittedOutputBytes + newOutputLen) / Math.max(1, state.rawInputBytes);
    if (projectedRatio > 3 && state.emittedOutputBytes > 1000) {
      state.triggered = true;
      const ratio = Math.round(projectedRatio * 100) / 100;
      console.error(
        `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x rawIn=${state.rawInputBytes}B emittedOut=${state.emittedOutputBytes}B account=${resolvedEmail} model=${model}`,
      );
      logStore.recordAmplificationEvent(logId, ratio, lastRawContent || lastVStrRaw || '');
    }
  }
  return state.triggered;
}
