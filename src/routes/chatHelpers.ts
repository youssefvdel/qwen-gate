import { randomUUID } from 'node:crypto';
import modelSpecs from '../models.json' with { type: 'json' };
import { modelRouter } from '../services/modelRouter.ts';
import { buildFeatureConfig, createQwenStream } from '../services/qwen.ts';
import { config } from '../services/configService.ts';
import { sessionPool } from '../services/sessionPool.ts';
import type { ModelSpec } from '../types/openai.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';
import { pendingCorrections } from './chatHelpersCore.ts';
import { compressToolResult } from './compressToolResult.ts';

/** Escape special XML characters in a string (for safe attribute & element content). */
function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Re-export everything from core utilities
export * from './chatHelpersCore.ts';

/** Pre-compiled regex patterns for user content sanitization */
const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
const TAG_STRIP_RE = /<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi;
const THINK_TAG_STRIP_RE = new RegExp(`<(?:${THINK_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\/(?:${THINK_TAG_NAMES.join('|')})>`, 'gi');
const ROLE_PREFIX_RE = /^(?:System|Assistant|User|Human):\s*/gim;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

// ── Types ─────────────────────────────────────────────────────────

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant' | 'function';
  content: string | Record<string, any>;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, any>;
  extra: Record<string, any>;
  sub_chat_type: string;
  parent_id: string | null;
  // Function-specific fields (only for role: 'function')
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: any;
  info?: Record<string, any>;
}

export interface BuildQwenMessagesResult {
  qwenMessages: QwenMessage[];
  systemContent?: string;
  toolResultsContent?: string;
}

// ── Business logic ───────────────────────────────────────────────

export function buildQwenMessages(messages: any[], body: any, availableTokens: number, _toolCalling: boolean): BuildQwenMessagesResult {
  const timestamp = Math.floor(Date.now() / 1000);
  const model = (body.model || '').replace('-no-thinking', '');

  const segments: string[] = [];
  const systemParts: string[] = [];
  const toolResultObjects: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'system') {
      systemParts.push((contentStr || '').trim());
    } else if (msg.role === 'user') {
      // Extract <system-reminder> blocks to systemParts instead of stripping them
      let text = contentStr;
      const sysReminders: string[] = [];
      text = text.replace(SYSTEM_REMINDER_RE, (_m: string, inner: string) => {
        sysReminders.push(inner.trim());
        return '';
      });
      sysReminders.forEach((r) => systemParts.push(r));

      let sanitized = text
        .replace(TAG_STRIP_RE, '')
        .replace(THINK_TAG_STRIP_RE, '')
        .replace(ROLE_PREFIX_RE, '')
        .replace(CONTROL_CHAR_RE, '')
        .trim();

      if (sanitized.length === 0) continue;

      const charLimit = Math.floor(availableTokens * 3.0);
      const truncated =
        sanitized.length > charLimit
          ? sanitized.substring(0, charLimit) +
            `\n\n[TRUNCATED: input exceeded ${charLimit} characters (model: ${body.model}, available tokens: ${availableTokens})]`
          : sanitized;

      segments.push(`<user>\n${truncated}\n</user>`);
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr || '';
      const reasoning = msg.reasoning_content;
      if (reasoning) assistantContent = `<thinking>\n${reasoning}\n</thinking>\n\n${assistantContent}`;

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: any = {};
          const args = tc.function?.arguments;
          if (typeof args === 'string') {
            try {
              parsedArgs = JSON.parse(args);
            } catch {
              parsedArgs = {};
            }
          } else if (args && typeof args === 'object') {
            parsedArgs = args;
          }
          const FKW = TOOL_CALL_KEYWORDS[0];
          const PKW = TOOL_CALL_KEYWORDS[1];
          const xmlParams = Object.entries(parsedArgs)
            .map(([k, v]) => `<${PKW}=${k}>${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</${PKW}>`)
            .join('\n');
          const xmlPayload = `<${FKW}=${tc.function?.name}>\n${xmlParams}\n</${FKW}>`;
          assistantContent = assistantContent ? assistantContent + '\n' + xmlPayload : xmlPayload;
        }
      }

      segments.push(`<assist>\n${assistantContent}\n</assist>`);
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find((tc: any) => tc.id === msg.tool_call_id);
            if (call) {
              toolName = call.function?.name;
              break;
            }
          }
        }
      }

      const truncated = compressToolResult(contentStr || '');
      toolResultObjects.push({
        type: 'function',
        tool: toolName || 'unknown',
        result: {
          success: true,
          stdout: truncated,
          stderr: '',
          command: toolName || '',
        },
      });
    }
  }

  // Single user message with all history wrapped in <user>/<assist> tags
  let prompt = segments.length > 0 ? segments.join('\n\n') : '';

  const featureConfig = buildFeatureConfig(true);

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const mode = config.get('TOOL_CALLING_MODE', 'xml_prompt');

    if (mode === 'local_mcp') {
      // Original behaviour: inject via feature_config.local_mcp (native Qwen API).
      // Broken on chat.qwen.ai as of mid-2026 — returns 500 Internal_Server_Error.
      // Kept for users whose Qwen deployments still support this path.
      const localMcp: Record<string, any> = {};
      localMcp['★'] = {};
      for (const t of body.tools) {
        const fn = t.function || {};
        localMcp['★'][fn.name] = {
          description: fn.description || '',
          input_schema: fn.parameters || { type: 'object', properties: {} },
        };
      }
      featureConfig.local_mcp = localMcp;
    } else {
      // xml_prompt (default): inject tool DEFINITIONS using a DISTINCT tag
      // (<tool name=..>) so they never collide with the <function=NAME>
      // INVOCATION tag that xmlToolParser matches. The model is instructed to
      // CALL tools with <function=NAME><parameter=K>V</parameter></function>,
      // which the parser converts back to OpenAI tool_calls.
      //
      // Why distinct tags: past assistant tool_calls in multi-turn history are
      // also serialized as <function=NAME>..</function> (see assistant branch
      // above). If definitions ALSO used <function=NAME>, the prompt would
      // contain three things sharing one tag — definitions, past calls, and the
      // call-format instruction — and the model conflates them, hallucinating
      // "Tool X does not exist". A separate <tool> tag removes the ambiguity.
      const toolDefs = body.tools.map((t: any) => {
        const fn = t.function || {};
        const props = fn.parameters?.properties || {};
        const required = fn.parameters?.required || [];
        const argLines: string[] = [];
        for (const [k, v] of Object.entries(props) as [string, any][]) {
          const req = required.includes(k) ? ' (required)' : '';
          argLines.push(`    <arg name="${escXml(k)}" type="${escXml(v.type || 'string')}">${escXml(v.description || '')}${req}</arg>`);
        }
        return `  <tool name="${escXml(fn.name)}">\n    <desc>${escXml(fn.description || '')}</desc>\n${argLines.join('\n')}\n  </tool>`;
      }).join('\n');

      const toolPrompt =
        '\n\n## AVAILABLE TOOLS\n' +
        'You can call these tools. Tool definitions (reference only — do NOT copy this format):\n' +
        '<tools>\n' + toolDefs + '\n</tools>\n\n' +
        'TO CALL A TOOL, emit EXACTLY this and nothing after the closing tag:\n' +
        '<function=TOOL_NAME>\n<parameter=ARG_NAME>value</parameter>\n</function>\n\n' +
        'Rules:\n' +
        '- Use the tool name from the <tool name="..."> list as TOOL_NAME.\n' +
        '- One <parameter=...> line per argument you pass.\n' +
        '- After </function>, STOP immediately. Output no other text.\n' +
        '- These tools ARE available in this environment. Call them — do not claim they are missing.';

      // Prepend to prompt so model sees it inline, not as file attachment
      prompt = toolPrompt + (prompt ? '\n' + prompt : '');
    }
  }

  // Single message (Qwen API only accepts 1 message per chat)
  const fid = randomUUID();
  const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  const formatToolResult = (r: {
    type: string;
    tool: string;
    result: { success: boolean; stdout?: string; stderr?: string; command?: string };
  }) =>
    `<tool_result tool="${r.tool}" success="${r.result.success}">\n<command>${escXml(r.result.command || '')}</command>\n<stdout>${escXml(r.result.stdout || '')}</stdout>\n<stderr>${escXml(r.result.stderr || '')}</stderr>\n</tool_result>`;
  const toolResultsContent = toolResultObjects.length > 0 ? toolResultObjects.map(formatToolResult).join('\n\n') : undefined;
  const qwenMessages: QwenMessage[] = [
    {
      fid,
      parentId: null,
      childrenIds: [randomUUID()],
      role: 'user',
      content: prompt || '\n',
      user_action: 'chat',
      files: [],
      timestamp,
      models: [model],
      chat_type: 't2t',
      feature_config: featureConfig,
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    },
  ];

  return { qwenMessages, systemContent, toolResultsContent };
}

export function handleImageModelFallback(body: any, messages: any[]): void {
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'));
  if (hasImages) {
    const modelId = (body.model as string)
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/-no-thinking$/, '');
    const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
    const supportsImages = specs?.modalities.includes('image');
    if (!supportsImages) {
      const original = body.model;
      body.model = 'qwen3.7-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
    }
  }
}

export function getModelSpecs(body: any): { maxContext: number; maxOutput: number } {
  const modelId = (body.model as string)
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-no-thinking$/, '');
  const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
  return {
    maxContext: specs?.max_context || 250000,
    maxOutput: specs?.max_output || 65000,
  };
}

export async function acquireSessionWithCorrections(
  accountEmail: string | undefined,
  qwenMessages: QwenMessage[],
): Promise<{
  session: any;
  qwenMessages: QwenMessage[];
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
}> {
  const session = await sessionPool.acquire(accountEmail);
  const prevCorrections =
    pendingCorrections.get(session.chatId) ||
    (accountEmail ? pendingCorrections.get(accountEmail) : undefined) ||
    pendingCorrections.get('__echo_retry__');
  if (prevCorrections && prevCorrections.length > 0) {
    pendingCorrections.delete(session.chatId);
    if (accountEmail) pendingCorrections.delete(accountEmail);
    pendingCorrections.delete('__echo_retry__');
    const correctionsBlock = prevCorrections.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n');
    const correctionText = `### FEEDBACK FROM PREVIOUS TURN\nThe following issues were detected in your previous response. Address them now:\n${correctionsBlock}\n\n`;

    // Prepend correction text to the first message's content
    qwenMessages = qwenMessages.map((m, idx) => {
      if (idx === 0 && typeof m.content === 'string') {
        return { ...m, content: correctionText + m.content };
      }
      return m;
    });
  }
  const nextParentId: string | null = session.parentId;
  const sessionHeaders = session.cachedHeaders || {};
  const resolvedEmail = session.accountEmail || accountEmail || '';
  return { session, qwenMessages, nextParentId, sessionHeaders, resolvedEmail };
}

export async function createQwenStreamWithRetry(
  qwenMessages: QwenMessage[],
  isThinkingModel: boolean,
  routedModel: string,
  chatId: string,
  nextParentId: string | null,
  resolvedEmail: string,
  tools?: unknown[],
  toolChoice?: unknown,
): Promise<{ stream: ReadableStream; abortController: AbortController; qwenLogFile?: string }> {
  try {
    const result = await createQwenStream(
      qwenMessages,
      isThinkingModel,
      routedModel,
      chatId,
      nextParentId,
      resolvedEmail,
      tools,
      toolChoice,
    );
    modelRouter.recordSuccess(routedModel);
    return { stream: result.stream, abortController: result.abortController, qwenLogFile: result.qwenLogFile };
  } catch (err: any) {
    modelRouter.recordError(routedModel);
    // ponytail: caller (chat.ts) handles session release — don't double-release
    throw err;
  }
}
