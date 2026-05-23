/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 *
 * Key design: uses JSON-depth tracking (not literal tag matching) to find
 * tool call boundaries. After <tool_call>, we scan for the opening {/[,
 * then walk with a bracket-depth+string-aware state machine. When depth
 * returns to 0 the JSON is complete. This means literal </tool_call>
 * strings inside JSON arguments CANNOT break parsing.
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
  private insideTool = false;
  private readonly TOOL_START = '<tool_call>';
  private readonly TOOL_END = '</tool_call>';
  private emittedToolCallCount = 0;
  private chunksSinceTagChange = 0;

  private insideThinking = false;
  private thinkEndTag: string = '';
  private thinkBuffer = '';
  private readonly THINK_TAGS: Array<{ start: string; end: string }> = [
    { start: '<' + 'think>', end: '<' + '/' + 'think>' },
    { start: '<' + 'thinking>', end: '<' + '/' + 'thinking>' },
  ];
  public passThrough = false;
  public skipPreProcess = false;
  public bufferToolCalls = false;
  private textBuffer = '';
  private recentText = '';
  private readonly MAX_RECENT = 4000;
  private readonly MAX_BUFFER_SIZE = 100_000;
  private readonly MAX_CHUNKS_INSIDE_TOOL = 5000;
  private readonly INSIDE_TOOL_CONTENT_LIMIT = 200_000;

  private readonly RE_BACKTICK_BEFORE_OPEN = /```(?:json|JSON)?\s*\n?(?=<tool_call>)/g;
  private readonly RE_BACKTICK_AFTER_CLOSE = /(?<=<\/tool_call>)\n?\s*```/g;
  private readonly RE_MARKDOWN_FENCE_OPEN = /^```(?:json)?\s*/gm;
  private readonly RE_MARKDOWN_FENCE_CLOSE = /```\s*$/gm;

  feed(chunk: string): ParserResult {
    if (this.passThrough) {
      this.buffer += chunk;
      return { text: chunk, toolCalls: [], thinking: '' };
    }
    if (!this.skipPreProcess) {
      chunk = chunk.replace(this.RE_BACKTICK_BEFORE_OPEN, '');
      chunk = chunk.replace(this.RE_BACKTICK_AFTER_CLOSE, '');
    }
    this.buffer += chunk;

    if (this.buffer.length > this.MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-this.MAX_BUFFER_SIZE);
    }

    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };

    this.extractThinking(result);

    if (!this.insideTool) {
      const preExtractLen = this.buffer.length;
      this.buffer = this.extractOrphanedToolCalls(this.buffer, result);
      if (this.buffer.length < preExtractLen) {
        this.insideTool = false;
        if (this.bufferToolCalls) {
          this.emitBufferedText(result);
        }
      }
    }

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        this.chunksSinceTagChange = 0;
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          const beforeTag = this.buffer.substring(0, startIdx);
          if (this.bufferToolCalls) {
            this.textBuffer += beforeTag;
          } else {
            result.text += beforeTag;
          }
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
          this.insideTool = true;
        } else {
          const partialTagLen = Math.max(
            this.getPartialTagLength(),
            this.getPartialCloserLength(this.buffer),
            this.getPartialThinkStartLength(this.buffer),
            this.insideThinking ? this.getPartialThinkEndLength(this.buffer, this.thinkEndTag) : 0
          );
          const flushLen = this.buffer.length - partialTagLen;
          if (flushLen > 0) {
            const flushed = this.buffer.substring(0, flushLen);
            result.text += flushed;
            this.recentText = (this.recentText + flushed).slice(-this.MAX_RECENT);
            this.buffer = this.buffer.substring(flushLen);
          }
          break;
        }
      } else {
        this.chunksSinceTagChange++;
        if (this.chunksSinceTagChange > this.MAX_CHUNKS_INSIDE_TOOL) {
          this.emitBufferedText(result);
          result.text += this.TOOL_START + this.buffer;
          this.buffer = '';
          this.insideTool = false;
          this.chunksSinceTagChange = 0;
          break;
        }
        if (this.buffer.length > this.INSIDE_TOOL_CONTENT_LIMIT) {
          this.emitBufferedText(result);
          result.text += this.TOOL_START + this.buffer;
          this.buffer = '';
          this.insideTool = false;
          this.chunksSinceTagChange = 0;
          break;
        }

        const jsonEnd = this.findJsonEnd(this.buffer);
        if (jsonEnd !== -1) {
          this.chunksSinceTagChange = 0;
          const content = this.buffer.substring(0, jsonEnd);
          this.buffer = this.buffer.substring(jsonEnd);

          const closingTag = this.buffer.indexOf(this.TOOL_END);
          if (closingTag !== -1 && closingTag < 20) {
            this.buffer = this.buffer.substring(closingTag + this.TOOL_END.length);
          } else if (this.buffer.startsWith(this.TOOL_END)) {
            this.buffer = this.buffer.substring(this.TOOL_END.length);
          }

          if (this.bufferToolCalls) {
            this.emitBufferedText(result);
          }
          this.processToolContent(content, result);
          this.insideTool = false;

          const orphanResult: ParserResult = { text: '', toolCalls: [], thinking: '' };
          const remaining = this.extractOrphanedToolCalls(this.buffer, orphanResult);
          if (orphanResult.text) result.text += orphanResult.text;
          this.buffer = remaining;
        } else {
          break;
        }
      }
    }

    return result;
  }

  private findJsonEnd(buf: string): number {
    let i = 0;
    while (i < buf.length && (buf[i] === ' ' || buf[i] === '\t' || buf[i] === '\n' || buf[i] === '\r')) {
      i++;
    }
    if (i >= buf.length) return -1;
    const first = buf[i];
    if (first !== '{' && first !== '[') return -1;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (; i < buf.length; i++) {
      const c = buf[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (c === '\\') {
        escaped = true;
        continue;
      }

      if (c === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (c === '{' || c === '[') {
        depth++;
      } else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
    }

    return -1;
  }

  private emitBufferedText(result: ParserResult): void {
    if (this.textBuffer) {
      result.text = this.textBuffer + result.text;
      this.textBuffer = '';
    }
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    if (this.passThrough) {
      result.text = this.buffer;
      this.buffer = '';
      return result;
    }

    if (this.insideThinking) {
      if (this.thinkBuffer || this.buffer) {
        result.thinking = this.thinkBuffer + this.buffer;
      }
      this.thinkBuffer = '';
      this.buffer = '';
      this.insideThinking = false;
      this.thinkEndTag = '';
    }

    if (!this.buffer) {
      if (this.bufferToolCalls && this.textBuffer) {
        result.text = this.textBuffer;
        this.textBuffer = '';
      }
      this.insideThinking = false;
      this.thinkEndTag = '';
      this.thinkBuffer = '';
      return result;
    }

    this.buffer = this.buffer.replace(this.RE_BACKTICK_BEFORE_OPEN, '');
    this.buffer = this.buffer.replace(this.RE_BACKTICK_AFTER_CLOSE, '');

    this.extractThinking(result);

    if (this.insideTool) {
      const jsonEnd = this.findJsonEnd(this.buffer);
      if (jsonEnd !== -1) {
        const content = this.buffer.substring(0, jsonEnd);
        this.buffer = this.buffer.substring(jsonEnd);
        const closingTag = this.buffer.indexOf(this.TOOL_END);
        if (closingTag !== -1 && closingTag < 20) {
          this.buffer = this.buffer.substring(closingTag + this.TOOL_END.length);
        } else if (this.buffer.startsWith(this.TOOL_END)) {
          this.buffer = this.buffer.substring(this.TOOL_END.length);
        }
        if (this.bufferToolCalls) {
          this.emitBufferedText(result);
        }
        this.processToolContent(content, result);
        this.insideTool = false;
      } else {
        if (this.bufferToolCalls) {
          this.emitBufferedText(result);
        }
        result.text += this.buffer;
        this.buffer = '';
        this.insideTool = false;
      }
    } else {
      const remaining = this.extractOrphanedToolCalls(this.buffer, result);
      if (remaining !== this.buffer) {
        if (remaining) {
          if (this.bufferToolCalls) {
            this.textBuffer += remaining;
          } else {
            result.text += remaining;
          }
        }
      } else {
        if (this.bufferToolCalls) {
          this.textBuffer += this.buffer;
        } else {
          result.text += this.buffer;
        }
      }
    }

    if (this.bufferToolCalls && this.textBuffer) {
      result.text = this.textBuffer + result.text;
      this.textBuffer = '';
    }

    this.buffer = '';
    this.insideTool = false;
    this.chunksSinceTagChange = 0;
    this.recentText = '';
    this.insideThinking = false;
    this.thinkEndTag = '';
    this.thinkBuffer = '';
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  private extractThinking(result: ParserResult): void {
    while (this.buffer.length > 0) {
      if (this.insideThinking) {
        const endIdx = this.buffer.indexOf(this.thinkEndTag);
        if (endIdx !== -1) {
          this.thinkBuffer += this.buffer.substring(0, endIdx);
          this.buffer = this.buffer.substring(endIdx + this.thinkEndTag.length);
          result.thinking += this.thinkBuffer;
          this.thinkBuffer = '';
          this.insideThinking = false;
          this.thinkEndTag = '';
        } else {
          const partialLen = this.getPartialThinkEndLength(this.buffer, this.thinkEndTag);
          const safeLen = this.buffer.length - partialLen;
          if (safeLen > 0) {
            this.thinkBuffer += this.buffer.substring(0, safeLen);
            this.buffer = this.buffer.substring(safeLen);
          }
          break;
        }
      } else {
        const match = this.findThinkStart(this.buffer);
        if (match.index !== -1) {
          // Emit text before the think tag to result.text (don't let it leak into thinking)
          if (match.index > 0) {
            result.text += this.buffer.substring(0, match.index);
          }
          this.buffer = this.buffer.substring(match.index + match.tag.length);
          this.insideThinking = true;
          this.thinkEndTag = match.endTag;
        } else {
          break;
        }
      }
    }
  }

  private findThinkStart(buf: string): { index: number; tag: string; endTag: string } {
    let best = { index: -1, tag: '', endTag: '' };
    for (const t of this.THINK_TAGS) {
      const idx = buf.indexOf(t.start);
      if (idx !== -1 && (best.index === -1 || idx < best.index)) {
        best = { index: idx, tag: t.start, endTag: t.end };
      }
    }
    return best;
  }

  private getPartialThinkStartLength(buf: string): number {
    let maxLen = 0;
    for (const t of this.THINK_TAGS) {
      for (let i = 1; i < t.start.length; i++) {
        if (buf.endsWith(t.start.substring(0, i))) {
          maxLen = Math.max(maxLen, i);
        }
      }
    }
    return maxLen;
  }

  private getPartialThinkEndLength(buf: string, endTag: string): number {
    if (!endTag) return 0;
    for (let i = 1; i < endTag.length; i++) {
      if (buf.endsWith(endTag.substring(0, i))) {
        return i;
      }
    }
    return 0;
  }

  private processToolContent(content: string, result: ParserResult): void {
    let t = content.trim();
    if (!t) return;

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

  private extractOrphanedToolCalls(buf: string, result: ParserResult): string {
    let cursor = 0;
    while (cursor < buf.length) {
      const fullCloserIdx = buf.indexOf(this.TOOL_END, cursor);
      let closerIdx = fullCloserIdx;
      let closerLen = this.TOOL_END.length;
      let isPartial = false;

      if (fullCloserIdx === -1) {
        const partialLen = this.getPartialCloserLength(buf);
        if (partialLen > 0) {
          closerIdx = buf.length - partialLen;
          closerLen = this.TOOL_END.length;
          isPartial = true;
        }
      }

      if (closerIdx === -1) break;

      const beforeCloser = buf.substring(cursor, closerIdx);
      const afterCloser = isPartial
        ? buf.substring(closerIdx)
        : buf.substring(closerIdx + closerLen);

      if (beforeCloser.includes(this.TOOL_START)) {
        cursor = closerIdx + closerLen;
        continue;
      }

      const jsonStart = beforeCloser.search(/[\[{]/);
      if (jsonStart === -1 && this.recentText) {
        const recentJson = this.recentText.search(/[\[{]/);
        if (recentJson !== -1) {
          const jsonStr = this.recentText.substring(recentJson);
          const end = this.findJsonEnd(jsonStr);
          if (end !== -1) {
            const jsonContent = jsonStr.substring(0, end);
            try {
              const parsed = robustParseJSON(jsonContent);
              if (parsed && typeof parsed === 'object') {
                const tc = this.parseToolCall(parsed);
                if (tc) {
                  result.toolCalls.push(tc);
                  this.emittedToolCallCount++;
                  this.recentText = this.recentText.substring(0, recentJson);
                  cursor = closerIdx + closerLen;
                  continue;
                }
              }
            } catch { /* not valid JSON from recentText */ }
          }
        }
        cursor = closerIdx + closerLen;
        continue;
      }

      if (jsonStart === -1) {
        if (isPartial) break;
        cursor = closerIdx + 1;
        continue;
      }

      const afterJson = beforeCloser.substring(jsonStart);
      const jsonEnd = this.findJsonEnd(afterJson);

      if (jsonEnd === -1) {
        if (isPartial) break;
        cursor = closerIdx + 1;
        continue;
      }

      const jsonStr = afterJson.substring(0, jsonEnd);

      try {
        const parsed = robustParseJSON(jsonStr);
        if (!parsed || typeof parsed !== 'object') {
          if (isPartial) break;
          cursor = closerIdx + 1;
          continue;
        }

        const tc = this.parseToolCall(parsed);
        if (!tc) {
          if (isPartial) break;
          cursor = closerIdx + 1;
          continue;
        }

        const textBeforeJson = beforeCloser.substring(0, jsonStart);
        if (textBeforeJson) result.text += textBeforeJson;

        result.toolCalls.push(tc);
        this.emittedToolCallCount++;

        if (isPartial) {
          buf = afterCloser;
          break;
        }

        cursor = 0;
        buf = afterCloser;
        continue;
      } catch {
        if (isPartial) break;
        cursor = closerIdx + 1;
        continue;
      }
    }

    return buf;
  }

  private getPartialCloserLength(buf: string): number {
    for (let i = 1; i < this.TOOL_END.length; i++) {
      if (buf.endsWith(this.TOOL_END.substring(0, i))) {
        return i;
      }
    }
    return 0;
  }
}
