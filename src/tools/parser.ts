/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private readonly TOOL_START = '<tool_call>';
  private readonly TOOL_END = '</tool_call>';
  private emittedToolCallCount = 0;
  private chunksSinceTagChange = 0;

  // When true, feed() returns raw text without any tool call parsing
  // Controlled by TOOL_CALLING=false env var.
  public passThrough = false;

  // When false, skip safety pre-processing (backtick stripping) before parsing.
  // Only applies when passThrough is false. Controlled by CLEAN_OUTPUT env var.
  public skipPreProcess = false;

  // Recent flushed text buffer — enables cross-chunk orphaned tool call detection.
  // When JSON arrives in one chunk and </tool_call> in the next, the orphan
  // extraction searches this buffer for JSON to pair with the closer.
  private recentText = '';
  private readonly MAX_RECENT = 4000;

  // Max buffer size (100KB) to prevent OOM on long streams without tool calls
  private readonly MAX_BUFFER_SIZE = 100_000;

  // Max chunks stuck in insideTool state before auto-reset
  private readonly MAX_CHUNKS_INSIDE_TOOL = 50;

  // Pre-compiled regex patterns (avoid re-creating on every feed())
  private readonly RE_BACKTICK_BEFORE_OPEN = /```(?:json|JSON)?\s*\n?(?=<tool_call>)/g;
  private readonly RE_BACKTICK_AFTER_CLOSE = /(?<=<\/tool_call>)\n?\s*```/g;
  private readonly RE_MARKDOWN_FENCE_OPEN = /^```(?:json)?\s*/gm;
  private readonly RE_MARKDOWN_FENCE_CLOSE = /```\s*$/gm;

  feed(chunk: string): ParserResult {
    if (this.passThrough) {
      this.buffer += chunk;
      return { text: chunk, toolCalls: [] };
    }
    // Safety pre-processing: strip backtick fences around tool_call tags.
    // Skipped when skipPreProcess=true (CLEAN_OUTPUT=false).
    if (!this.skipPreProcess) {
      chunk = chunk.replace(this.RE_BACKTICK_BEFORE_OPEN, '');
      chunk = chunk.replace(this.RE_BACKTICK_AFTER_CLOSE, '');
    }
    this.buffer += chunk;

    // Enforce max buffer size — truncate oldest data if exceeded
    if (this.buffer.length > this.MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-this.MAX_BUFFER_SIZE);
    }

    const result: ParserResult = { text: '', toolCalls: [] };

    // Step 1: Extract any orphaned tool calls first (model outputs JSON without
    // opening <tool_call> tag). This must run before the tag-based loop below
    // so orphaned calls are caught even when proper tags exist later in the buffer.
    this.buffer = this.extractOrphanedToolCalls(this.buffer, result);
    if (this.insideTool) this.insideTool = false;

    // Step 2: Normal tag-based parsing for remaining buffer
    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        this.chunksSinceTagChange = 0;
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          result.text += this.buffer.substring(0, startIdx);
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
          this.insideTool = true;
        } else {
          // Check for partial opening tag before flushing
          const partialLength = this.getPartialTagLength();
          const flushLen = this.buffer.length - partialLength;
          if (flushLen > 0) {
            const flushed = this.buffer.substring(0, flushLen);
            result.text += flushed;
            // Save flushed text for cross-chunk orphan detection
            this.recentText = (this.recentText + flushed).slice(-this.MAX_RECENT);
            this.buffer = this.buffer.substring(flushLen);
          }
          break;
        }
      } else {
        this.chunksSinceTagChange++;
        // Auto-reset if stuck insideTool for too many chunks (model forgot closing tag).
        // Flush accumulated buffer as text and exit tool mode to avoid infinite cycles.
        if (this.chunksSinceTagChange > this.MAX_CHUNKS_INSIDE_TOOL) {
          result.text += this.TOOL_START + this.buffer;
          this.buffer = '';
          this.insideTool = false;
          this.chunksSinceTagChange = 0;
          break;
        }
        const endIdx = this.buffer.indexOf(this.TOOL_END);
        if (endIdx !== -1) {
          this.chunksSinceTagChange = 0;
          const content = this.buffer.substring(0, endIdx);
          this.buffer = this.buffer.substring(endIdx + this.TOOL_END.length);
          this.processToolContent(content, result);
          this.insideTool = false;
        } else {
          break;
        }
      }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (this.passThrough) {
      result.text = this.buffer;
      this.buffer = '';
      return result;
    }
    if (!this.buffer) return result;

    // Strip backtick fences as in feed()
    this.buffer = this.buffer.replace(this.RE_BACKTICK_BEFORE_OPEN, '');
    this.buffer = this.buffer.replace(this.RE_BACKTICK_AFTER_CLOSE, '');

    if (this.insideTool) {
      this.processToolContent(this.buffer, result);
    } else {
      const remaining = this.extractOrphanedToolCalls(this.buffer, result);
      if (remaining !== this.buffer) {
        if (remaining) result.text += remaining;
      } else {
        result.text += this.buffer;
      }
    }

    this.buffer = '';
    this.insideTool = false;
    this.chunksSinceTagChange = 0;
    this.recentText = '';
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  private processToolContent(content: string, result: ParserResult): void {
    let t = content.trim();
    if (!t) return;

    // Strip markdown code blocks if the model wraps JSON in ```json ... ```
    // This happens when the model doesn't follow instructions perfectly.
    if (t.startsWith('`') || t.startsWith('```')) {
      t = t.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
    }

    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
      } catch {
        result.text += this.TOOL_START + content + this.TOOL_END;
      }
    } else if (t.startsWith('{')) {
      const tc = this.parseToolContent(t);
      if (tc) {
        result.toolCalls.push(tc);
        this.emittedToolCallCount++;
      } else {
        result.text += this.TOOL_START + content + this.TOOL_END;
      }
    } else {
      result.text += this.TOOL_START + content + this.TOOL_END;
    }
  }

  private parseToolContent(str: string): ParsedToolCall | null {
    try {
      const parsed = robustParseJSON(str);
      if (!parsed || typeof parsed !== 'object') return null;
      return this.parseToolCall(parsed);
    } catch {
      return null;
    }
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== 'object') return null;
    
    const name = parsed.name || parsed.function?.name;
    if (!name || typeof name !== 'string') return null;
    
    let args = parsed.arguments || parsed.function?.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return {
      id: `call_${uuidv4()}`,
      name,
      arguments: args,
    };
  }

  private getPartialTagLength(): number {
    for (let i = 1; i < this.TOOL_START.length; i++) {
      if (this.buffer.endsWith(this.TOOL_START.substring(0, i))) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Iteratively extract all orphaned tool calls from the buffer.
   *
   * Model sometimes outputs JSON without an opening <tool_call> tag:
   *   {"name":"grep","arguments":{}}
   *   </tool_call>
   *
   * This scans for </tool_call>, extracts JSON before it, and if it's a valid
   * tool call (has name + arguments), adds it to result. Repeats until no more
   * orphaned closers are found. Also handles </tool_call> split across chunks
   * by checking for partial closing tags.
   *
   * Returns remaining text after extraction.
   */
  private extractOrphanedToolCalls(buf: string, result: ParserResult): string {
    let cursor = 0;
    while (cursor < buf.length) {
      // Look for a full </tool_call> or a partial one at the buffer boundary
      const fullCloserIdx = buf.indexOf(this.TOOL_END, cursor);
      const partialLen = this.getPartialCloserLength(buf);

      let closerIdx = fullCloserIdx;
      let closerLen = this.TOOL_END.length;

      // If no full closer but there's a partial one at the end, treat it as orphaned
      if (fullCloserIdx === -1 && partialLen > 0) {
        closerIdx = buf.length - partialLen;
        closerLen = partialLen;
        // Partial closer means the rest of </tool_call> is in the next chunk.
        // We try to parse what we have before the partial.
      }

      if (closerIdx === -1) break;

      const beforeCloser = buf.substring(cursor, closerIdx);
      const afterCloser = buf.substring(closerIdx + closerLen);

      // Skip if there's a matching opening tag before this closer (not orphaned).
      // Don't break — there might be orphaned calls later in the buffer.
      if (beforeCloser.includes(this.TOOL_START)) {
        cursor = closerIdx + closerLen;
        continue;
      }

      // Find a JSON object/array start before the </tool_call>.
      // If none found, check recentText (JSON might be from a previous chunk).
      let jsonStart = beforeCloser.search(/[\[{]/);
      if (jsonStart === -1 && this.recentText) {
        const recentJson = this.recentText.search(/[\[{]/);
        if (recentJson !== -1) {
          // Try to parse the JSON from recentText as a tool call
          const jsonStr = this.recentText.substring(recentJson);
          try {
            const parsed = robustParseJSON(jsonStr);
            if (parsed && typeof parsed === 'object') {
              const tc = this.parseToolCall(parsed);
              if (tc) {
                result.toolCalls.push(tc);
                this.emittedToolCallCount++;
                // Remove the JSON from recentText
                this.recentText = this.recentText.substring(0, recentJson);
                cursor = closerIdx + closerLen;
                continue;
              }
            }
          } catch { /* not valid JSON from recentText */ }
        }
        cursor = closerIdx + closerLen;
        continue;
      }

      const jsonStr = beforeCloser.substring(jsonStart);

      try {
        const parsed = robustParseJSON(jsonStr);
        if (!parsed || typeof parsed !== 'object') {
          cursor = closerIdx + 1;
          continue;
        }

        const tc = this.parseToolCall(parsed);
        if (!tc) {
          cursor = closerIdx + 1;
          continue;
        }

        // Valid tool call — emit it
        const textBeforeJson = beforeCloser.substring(0, jsonStart);
        if (textBeforeJson) result.text += textBeforeJson;

        result.toolCalls.push(tc);
        this.emittedToolCallCount++;

        // Move past this closer and keep scanning
        cursor = 0;
        buf = afterCloser;
        continue;
      } catch {
        cursor = closerIdx + 1;
        continue;
      }
    }

    return buf;
  }

  /**
   * Check if the buffer ends with a partial </tool_call> tag (e.g. </tool_cal)
   * so orphan detection can handle it even when split across chunks.
   */
  private getPartialCloserLength(buf: string): number {
    for (let i = 1; i < this.TOOL_END.length; i++) {
      if (buf.endsWith(this.TOOL_END.substring(0, i))) {
        return i;
      }
    }
    return 0;
  }
}