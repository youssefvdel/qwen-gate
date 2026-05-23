/*
 * Streaming JSON tool call parser.
 * Extracts {"name": ..., "arguments": {...}} from text chunks.
 * Strips markdown fences automatically.
 * Tracks position to avoid re-emitting text on cumulative streams.
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
  thinking: string;
}

export class StreamingToolParser {
  private buffer = '';
  private emittedCount = 0;
  // Track how far into the buffer we've emitted as text.
  // Only emit text that appears AFTER this position.
  private textEmissionBoundary = 0;

  public passThrough = false;
  public skipPreProcess = false;

  feed(chunk: string): ParserResult {
    if (this.passThrough) {
      this.buffer += chunk;
      return { text: chunk, toolCalls: [], thinking: '' };
    }

    if (!this.skipPreProcess) {
      chunk = chunk.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
    }

    this.buffer += chunk;
    return this.extract();
  }

  private extract(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    let offset = 0;

    while (offset < this.buffer.length) {
      // Skip already-handled think blocks (XML tags stripped in feed())
      if (this.buffer.startsWith('<think>', offset) || this.buffer.startsWith('<thinking>', offset)) {
        const tagName = this.buffer[offset + 1] === 't' && this.buffer[offset + 6] === '>' ? 'think' : 'thinking';
        const tagLen = tagName === 'think' ? 7 : 10;
        const endTag = this.buffer.indexOf(`</${tagName}>`, offset + tagLen);
        if (endTag !== -1) {
          result.thinking += this.buffer.substring(offset + tagLen, endTag);
          offset = endTag + tagLen + 3;
          this.textEmissionBoundary = offset;
          continue;
        }
        break;
      }

      // Find partial JSON object starts: {"  that aren't complete JSON yet
      const nextBraceQuote = this.buffer.indexOf('{"', offset);
      const nameIdx = this.buffer.indexOf('"name"', offset);

      // If we found a {" but no "name" after it (or "name" is too far), suppress the fragment
      if (nextBraceQuote !== -1 && (nameIdx === -1 || nameIdx > nextBraceQuote + 500 || nameIdx < nextBraceQuote)) {
        // Check if this {" is followed by a complete JSON object
        const after = this.buffer.substring(nextBraceQuote);
        const jsonEnd = this.findJsonEnd(after);
        if (jsonEnd === -1) {
          // Incomplete JSON — suppress the {" fragment and everything after it until we have more data
          if (this.textEmissionBoundary < nextBraceQuote) {
            result.text += this.buffer.substring(this.textEmissionBoundary, nextBraceQuote);
            this.textEmissionBoundary = nextBraceQuote;
          }
          // Don't emit anything after the { — wait for more chunks
          break;
        }
        
        const jsonStr = after.substring(0, jsonEnd);
        if (jsonStr.includes('"name"') && jsonStr.includes('"arguments"')) {
          // Complete JSON object with name and arguments — try to parse as tool call
          try {
            const parsed = robustParseJSON(jsonStr);
            if (parsed && typeof parsed === 'object') {
              const tc = this.parseToolCall(parsed);
              if (tc) {
                if (this.textEmissionBoundary < nextBraceQuote) {
                  result.text += this.buffer.substring(this.textEmissionBoundary, nextBraceQuote);
                  this.textEmissionBoundary = nextBraceQuote;
                }
                result.toolCalls.push(tc);
                this.emittedCount++;
                offset = nextBraceQuote + jsonEnd;
                this.textEmissionBoundary = offset;
                continue;
              }
            }
          } catch { }
          
          // Parse failed but JSON was complete — emit text up to and including the JSON
          if (this.textEmissionBoundary < nextBraceQuote + jsonEnd) {
            result.text += this.buffer.substring(this.textEmissionBoundary, nextBraceQuote + jsonEnd);
            this.textEmissionBoundary = nextBraceQuote + jsonEnd;
          }
          offset = nextBraceQuote + jsonEnd;
          continue;
        }
        
        // JSON is complete but doesn't have both name and arguments — suppress it
        offset = nextBraceQuote + jsonEnd;
        this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
        continue;
      }

      if (nameIdx === -1) {
        // No "name" found anywhere — emit all remaining text
        if (this.textEmissionBoundary < this.buffer.length) {
          result.text += this.buffer.substring(this.textEmissionBoundary);
          this.textEmissionBoundary = this.buffer.length;
        }
        break;
      }

      const searchFrom = Math.max(offset, nameIdx - 300);
      const braceIdx = this.buffer.lastIndexOf('{', nameIdx);
      if (braceIdx === -1 || braceIdx < searchFrom) {
        offset = nameIdx + 1;
        continue;
      }

      const after = this.buffer.substring(braceIdx);
      const jsonEnd = this.findJsonEnd(after);
      if (jsonEnd === -1) {
        if (this.textEmissionBoundary < braceIdx) {
          result.text += this.buffer.substring(this.textEmissionBoundary, braceIdx);
          this.textEmissionBoundary = braceIdx;
        }
        break;
      }

      const jsonStr = after.substring(0, jsonEnd);
      if (!jsonStr.includes('"arguments"')) {
        // JSON object has "name" but no "arguments" — malformed, suppress it entirely
        offset = braceIdx + jsonEnd;
        this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
        continue;
      }

      try {
        const parsed = robustParseJSON(jsonStr);
        if (parsed && typeof parsed === 'object') {
          const tc = this.parseToolCall(parsed);
          if (tc) {
            if (this.textEmissionBoundary < braceIdx) {
              result.text += this.buffer.substring(this.textEmissionBoundary, braceIdx);
              this.textEmissionBoundary = braceIdx;
            }

            result.toolCalls.push(tc);
            this.emittedCount++;
            offset = braceIdx + jsonEnd;
            this.textEmissionBoundary = offset;
            continue;
          }
        }
        
        // Parsed but not a valid tool call — suppress the JSON
        offset = braceIdx + jsonEnd;
        this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
        continue;
      }       catch { }
      offset = Math.max(offset + 1, braceIdx + 1);
      continue;
    }

    // Update buffer: only keep what we haven't fully processed
    // Cap buffer at 64KB to prevent O(n^2) degradation over long sessions
    if (this.textEmissionBoundary > 65536) {
      this.buffer = this.buffer.substring(this.textEmissionBoundary - 4096);
      const trimDelta = this.textEmissionBoundary - 4096;
      this.textEmissionBoundary = 4096;
      offset -= trimDelta;
    }
    if (offset > 0 && offset < this.buffer.length) {
      this.buffer = this.buffer.substring(offset);
      this.textEmissionBoundary -= offset;
      if (this.textEmissionBoundary < 0) this.textEmissionBoundary = 0;
    } else if (offset >= this.buffer.length) {
      this.buffer = '';
      this.textEmissionBoundary = 0;
    }

    return result;
  }

  private findJsonEnd(buf: string): number {
    let i = 0;
    while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
    if (i >= buf.length || (buf[i] !== '{' && buf[i] !== '[')) return -1;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < buf.length; i++) {
      const c = buf[i];
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

  private parseToolCall(parsed: any): ParsedToolCall | null {
    const name = parsed.name || parsed.function?.name;
    if (!name || typeof name !== 'string') return null;

    let args = parsed.arguments || parsed.function?.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return { id: `call_${uuidv4()}`, name, arguments: args };
  }

  flush(): ParserResult {
    const result: ParserResult = {
      text: this.buffer.substring(this.textEmissionBoundary),
      toolCalls: [],
      thinking: ''
    };
    this.buffer = '';
    this.textEmissionBoundary = 0;
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedCount;
  }
}