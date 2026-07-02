import crypto from 'node:crypto';
import { logStore } from '../services/logStore.ts';

// ponytail: use dotted model names matching the Qwen API (/v1/models response).
// models.json keys use dashes (qwen3-7-max) but Qwen API expects dots (qwen3.7-max).
const ANTHROPIC_TO_QWEN: Record<string, string> = {
  'claude-sonnet-4-20250514': 'qwen3.7-max',
  'claude-sonnet-4-20241022': 'qwen3.6-plus',
  'claude-3-5-sonnet-20241022': 'qwen3.6-plus',
  'claude-opus-4-20250514': 'qwen3.7-max',
  'claude-opus-4-8': 'qwen3.7-max',
  'claude-sonnet-4-8': 'qwen3.7-max',
  'claude-3-opus-20240229': 'qwen3.7-max',
  'claude-sonnet-4-6-20250514': 'qwen3.7-max',
  'claude-3-haiku-20240307': 'qwen3.5-flash',
};
const DEFAULT_QWEN_MODEL = 'qwen3.7-max';

function mapModel(anthropicModel: string): string {
  return ANTHROPIC_TO_QWEN[anthropicModel] || DEFAULT_QWEN_MODEL;
}

// ── Types ──────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

// ── Request conversion ─────────────────────────────────────────────

function anthropicMessagesToOpenAI(messages: AnthropicMessage[], system?: string): any[] {
  const out: any[] = [];
  if (system) {
    out.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const imageParts: any[] = [];
        let hasToolResult = false;
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text || '');
          } else if (block.type === 'image') {
            const src = block.source;
            if (src?.type === 'base64' && src.media_type && src.data) {
              imageParts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
            } else if (src?.type === 'url' && src.data) {
              imageParts.push({ type: 'image_url', image_url: { url: src.data } });
            }
          } else if (block.type === 'tool_result') {
            hasToolResult = true;
            const tc = typeof block.content === 'string' ? block.content : '';
            out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: tc });
          } else {
            console.warn(`[Anthropic] Unknown content block: ${block.type}`);
          }
        }
        if (!hasToolResult) {
          if (imageParts.length > 0) {
            const content: any[] = [];
            if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('\n') });
            content.push(...imageParts);
            out.push({ role: 'user', content });
          } else {
            out.push({ role: 'user', content: textParts.join('\n') });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text || '');
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // ponytail: skip thinking blocks — model reasoning, not input to Qwen
          } else {
            console.warn(`[Anthropic] Unknown assistant block: ${block.type}`);
          }
        }
        const text = textParts.join('\n');
        if (toolCalls.length > 0) {
          out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
        } else {
          out.push({ role: 'assistant', content: text });
        }
      }
    }
  }
  return out;
}

function anthropicToolsToOpenAI(tools?: any[]): any[] {
  if (!tools?.length) return [];
  return tools.map((t: any) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

// ── Response conversion ────────────────────────────────────────────

function finishReasonToAnthropic(reason: string): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

// ponytail: normalize Qwen tool name case to match Claude Code conventions
function normalizeToolName(name: string): string {
  const CASE_MAP: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
  };
  return CASE_MAP[name] || name;
}

// ponytail: simple formatter for Anthropic content blocks in log display
function formatContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b: any) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') return `[Tool: ${b.name}]`;
      if (b.type === 'tool_result') {
        const r = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return `[Result: ${r}]`;
      }
      if (b.type === 'thinking') return '';
      return JSON.stringify(b);
    })
    .filter(Boolean)
    .join('\n');
}

// ponytail: static Claude Code required param map — adapt if tools vary
const REQUIRED_PARAMS: Record<string, string[]> = {
  Bash: ['command'],
  Read: ['filePath'],
  Edit: ['filePath', 'oldString', 'newString'],
  Write: ['filePath', 'content'],
};

// ponytail: snake_case → camelCase mapping for Qwen param names
const SNAKE_TO_CAMEL: Record<string, string> = {
  file_path: 'filePath',
  old_string: 'oldString',
  new_string: 'newString',
  tool_call_id: 'toolCallId',
};

function mapParamName(paramName: string): string {
  return SNAKE_TO_CAMEL[paramName] || paramName;
}

function isValidToolCall(name: string, args: any): boolean {
  const required = REQUIRED_PARAMS[name];
  if (required) {
    const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
    if (missing.length > 0) return false;
  } else if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    return false;
  }
  return true;
}

function convertOpenAIResponseToAnthropic(openAIResp: any, requestModel: string): any {
  const choice = openAIResp.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object') continue;
      // Map snake_case to camelCase
      const mapped: any = {};
      for (const [k, v] of Object.entries(args)) {
        mapped[mapParamName(k)] = v;
      }
      const normalizedName = normalizeToolName(tc.function.name);
      if (!isValidToolCall(normalizedName, mapped)) {
        logStore.log(
          'debug',
          'chat',
          `[Anthropic] Skipped invalid tool call in non-streaming: ${tc.function?.name} args=${JSON.stringify(mapped)}`,
        );
        continue;
      }
      content.push({ type: 'tool_use', id: tc.id, name: normalizedName, input: mapped });
    }
  }
  // Anthropic doesn't send text + tool_use together — prefer tool_use
  if (content.length > 1 && content.some((c: any) => c.type === 'tool_use')) {
    const toolBlocks = content.filter((c: any) => c.type === 'tool_use');
    content.length = 0;
    content.push(...toolBlocks);
  }
  return {
    id: 'msg_' + crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: finishReasonToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: openAIResp.usage?.prompt_tokens || 0, output_tokens: openAIResp.usage?.completion_tokens || 0 },
  };
}

export {
  AnthropicContentBlock,
  AnthropicMessage,
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  convertOpenAIResponseToAnthropic,
  formatContent,
  isValidToolCall,
  mapModel,
  mapParamName,
  normalizeToolName,
  REQUIRED_PARAMS,
};
