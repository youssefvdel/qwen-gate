import { randomUUID } from 'node:crypto';
import modelSpecs from '../models.json' with { type: 'json' };
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { buildFeatureConfig, createQwenStream } from '../services/qwen.ts';
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

      if (sanitized.length === 0) {
        // The user turn contained ONLY <system-reminder> blocks (e.g. Claude Code
        // SessionStart hook / superpowers sync). Dropping it leaves Qwen with a
        // system-only prompt and no user content, which makes it return an empty
        // end_turn — causing Claude Code to churn forever without answering.
        // Keep the reminders as the user turn instead.
        if (sysReminders.length > 0) {
          segments.push(`<user>\n${sysReminders.join('\n\n')}\n</user>`);
        }
        continue;
      }

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

  // Single user message with all history wrapped in <user>/<assist> tags.
  // System instructions MUST stay inline (at the top) — previously they were
  // sent only to the uploaded context.txt file, which made the model focus on
  // the file ("context.txt contains only instructions") instead of answering,
  // often returning an empty end_turn. Keeping them inline fixes that.
  let prompt = segments.length > 0 ? segments.join('\n\n') : '';
  const inlineSystem = systemParts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
  if (inlineSystem) {
    prompt = `<system>\n${inlineSystem}\n</system>\n\n${prompt}`;
  }

  // Thinking level is resolved by the route handlers (Anthropic / OpenAI)
  // from the client's thinking intent + THINKING_MODE config, then attached
  // to body.thinkingLevel. Fall back to the -no-thinking model suffix.
  const thinkingLevel: 'off' | 'summary' | 'full' =
    (body.thinkingLevel as 'off' | 'summary' | 'full' | undefined) || (body.model.includes('-no-thinking') ? 'off' : 'summary');
  const featureConfig = buildFeatureConfig(thinkingLevel !== 'off', thinkingLevel === 'full' ? 'full' : 'summary');

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const localMcp: Record<string, any> = {};
    localMcp['★'] = {};
    const toolNames: string[] = [];
    for (const t of body.tools) {
      const fn = t.function || {};
      localMcp['★'][fn.name] = {
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
      toolNames.push(`${fn.name}${fn.description ? ` (${fn.description})` : ''}`);
    }
    // Qwen silently returns an EMPTY completion when feature_config.local_mcp
    // (the tool definitions) is too large (~>127KB serialized). Claude Code
    // ships huge tool descriptions (Bash ~10KB, Workflow ~19KB) that with 60+
    // tools blow past the limit and produce zero output. Shrink the longest
    // descriptions until the whole local_mcp fits in the budget.
    const mcpBudget = config.getInt('LOCAL_MCP_MAX_CHARS', 115000);
    let mcpJson = JSON.stringify(localMcp);
    if (mcpJson.length > mcpBudget) {
      let shrunk = true;
      let guard = 0;
      while (mcpJson.length > mcpBudget && shrunk && guard < 200) {
        shrunk = false;
        let longestName: string | null = null;
        let longestLen = 0;
        for (const [name, def] of Object.entries(localMcp['★'])) {
          const dl = ((def as { description?: string }).description || '').length;
          if (dl > longestLen) {
            longestLen = dl;
            longestName = name;
          }
        }
        if (longestName && longestLen > 40) {
          const target = Math.floor(longestLen / 2);
          const cur = localMcp['★'][longestName] as { description?: string };
          cur.description = (cur.description || '').slice(0, Math.max(40, target));
          shrunk = true;
          guard++;
          mcpJson = JSON.stringify(localMcp);
        }
      }
      if (mcpJson.length > mcpBudget) {
        logStore.log('warn', 'chat', `[Tools] local_mcp still ${mcpJson.length}B after shrinking — trimmed below budget ${mcpBudget}`);
      } else {
        logStore.log('debug', 'chat', `[Tools] local_mcp shrunk to ${mcpJson.length}B (budget ${mcpBudget}B)`);
      }
    }
    featureConfig.local_mcp = localMcp;
    // ponytail: tool schema in system prompt as textual fallback for models
    // that don't honor feature_config.local_mcp consistently
    const toolDescriptions = Object.entries(localMcp['★'])
      .map(([name, def]: [string, any]) => {
        const params = def.input_schema?.properties ? Object.keys(def.input_schema.properties).join(', ') : '';
        return `- ${name}${def.description ? `: ${def.description}` : ''}${params ? ` (params: ${params})` : ''}`;
      })
      .join('\n');
    systemParts.push(
      `You have access to the following tools:\n${toolDescriptions}\n\nTo call a tool, respond with the tool call in the appropriate format.`,
    );
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
