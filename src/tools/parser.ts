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

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          result.text += this.buffer.substring(0, startIdx);
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
          this.insideTool = true;
        } else {
          const partialLength = this.getPartialTagLength();
          const flushIndex = this.buffer.length - partialLength;
          if (flushIndex > 0) {
            result.text += this.buffer.substring(0, flushIndex);
            this.buffer = this.buffer.substring(flushIndex);
          }
          break;
        }
      } else {
        const endIdx = this.buffer.indexOf(this.TOOL_END);
        if (endIdx !== -1) {
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
    if (!this.buffer) return result;

    if (this.insideTool) {
      this.processToolContent(this.buffer, result);
    } else {
      result.text += this.buffer;
    }

    this.buffer = '';
    this.insideTool = false;
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  private processToolContent(content: string, result: ParserResult): void {
    const t = content.trim();
    if (!t) return;

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
}