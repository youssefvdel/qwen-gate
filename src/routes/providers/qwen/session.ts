/*
 * File: providers/qwen/session.ts
 * Qwen session acquisition — account pool → file upload → session → stream.
 *
 * Used by providerQwen.ts and anthropic.ts. Both callers pass a `label` for log
 * prefixes (`[Qwen]` / `[Anthropic]`). All Qwen-specific transport details live here
 * because both providers ultimately tunnel through the same session pool.
 *
 * This is NOT a generic abstraction — it's Qwen-session acquisition.
 */

import { randomUUID } from 'node:crypto';
import { pickAccount, throttleAccount } from '../../../services/auth.ts';
import { logStore } from '../../../services/logStore.ts';
import { modelRouter } from '../../../services/modelRouter.ts';
import { buildFeatureConfig, createQwenStream, RetryableQwenStreamError } from '../../../services/qwen.ts';
import type { QwenFileAttachment } from '../../../services/qwenFileUpload.ts';
import { uploadImageAsFile, uploadLargeTextAsFile } from '../../../services/qwenFileUpload.ts';
import { sessionPool } from '../../../services/sessionPool.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../../../utils/tagNames.ts';
import { pendingCorrections } from '../../chatHelpersCore.ts';
import { compressToolResult } from '../../compressToolResult.ts';

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

export interface SessionSetupResult {
  sessionMessages: any[];
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
  stream: ReadableStream;
  qwenAbortController: AbortController;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_ACCOUNT_RETRIES = 5;
const MAX_INLINE_CHARS = 50000;
const FIRST_CHUNK_MS = 60_000;

const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
const TAG_STRIP_RE = /<\|[^>]*\|>/g;
const THINK_TAG_STRIP_RE = new RegExp(`<\\/?(${THINK_TAG_NAMES.join('|')})\\b[^>]*>`, 'gi');
const ROLE_PREFIX_RE = /^(?:System|Assistant|User|Human):\s*/gim;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

// ── XML escaping ─────────────────────────────────────────────────────

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Qwen message builder ──────────────────────────────────────────────

function buildQwenMessages(messages: any[], body: any, availableTokens: number, _toolCalling: boolean): BuildQwenMessagesResult {
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

      const effectiveTokens = Math.max(availableTokens, 256);
      const charLimit = Math.floor(effectiveTokens * 3.0);
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

  let prompt = segments.length > 0 ? segments.join('\n\n') : '';
  const featureConfig = buildFeatureConfig(true);

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
    featureConfig.local_mcp = localMcp;
    const toolDescriptions = body.tools
      .map((t: any) => {
        const fn = t.function || {};
        const params = fn.parameters?.properties ? Object.keys(fn.parameters.properties).join(', ') : '';
        return `- ${fn.name}${fn.description ? `: ${fn.description}` : ''}${params ? ` (params: ${params})` : ''}`;
      })
      .join('\n');
    systemParts.push(
      `You have access to the following tools:\n${toolDescriptions}\n\nTo call a tool, respond with the tool call in the appropriate format.`,
    );
  }

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

// ── Session acquisition ────────────────────────────────────────────────

async function acquireSessionWithCorrections(
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

// ── Stream creation ────────────────────────────────────────────────────

async function createQwenStreamWithRetry(
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
    throw err;
  }
}

// ── Shared session primitive ───────────────────────────────────────────

export async function setupSession(
  messages: any[],
  body: OpenAIRequest,
  availableTokens: number,
  toolCalling: boolean,
  logId: string,
  label: string = 'Qwen',
): Promise<SessionSetupResult> {
  // ── Image detection ──────────────────────────────────────────
  let hasImages = false;
  const imageUrls: string[] = [];

  const lastMsg = messages[messages.length - 1];
  if (lastMsg && Array.isArray(lastMsg.content)) {
    for (const part of lastMsg.content) {
      if (part?.type === 'image_url' && part?.image_url?.url) {
        hasImages = true;
        imageUrls.push(part.image_url.url);
      }
    }
  }

  let cleanedMessages = messages;
  if (hasImages) {
    cleanedMessages = messages.map((msg: any, idx: number) => {
      if (idx !== messages.length - 1) return msg;
      if (!Array.isArray(msg.content)) return msg;
      const textParts = msg.content.filter((c: any) => c.type !== 'image_url');
      return { ...msg, content: textParts.length > 0 ? textParts : [{ type: 'text', text: '[Image]' }] };
    });
  }

  const {
    qwenMessages: processedMessages,
    systemContent,
    toolResultsContent,
  } = buildQwenMessages(cleanedMessages, body, availableTokens, toolCalling);

  // ── Inline content truncation ─────────────────────────────────
  let inlineContent = processedMessages[0].content as string;
  let chatHistoryContent = '';

  if (typeof inlineContent === 'string' && inlineContent.length > MAX_INLINE_CHARS) {
    const parts = inlineContent.split(/\n\n(?=<user>|<assist>)/);
    let keptLen = 0;
    let splitIdx = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const addLen = parts[i].length + (keptLen > 0 ? 2 : 0);
      if (keptLen + addLen <= MAX_INLINE_CHARS) {
        keptLen += addLen;
        splitIdx = i;
      } else break;
    }
    if (splitIdx > 0) {
      chatHistoryContent = parts.slice(0, splitIdx).join('\n\n');
      inlineContent = parts.slice(splitIdx).join('\n\n');
      processedMessages[0] = { ...processedMessages[0], content: inlineContent };
    }
  }

  let lastFailedEmail: string | undefined;
  const isThinkingModel = !body.model.includes('no-thinking');
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    const selectedAccount = await pickAccount(lastFailedEmail);
    const accountEmail = selectedAccount?.email;
    logStore.log(
      'debug',
      'chat',
      `[${label}] Attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES} picked=${accountEmail || 'NONE'} lastFailed=${lastFailedEmail || 'none'}`,
    );
    if (!selectedAccount && attempt > 0) {
      logStore.log(
        'error',
        'chat',
        `[${label}] All ${MAX_ACCOUNT_RETRIES} attempts exhausted — last error: ${lastError?.message || lastError || 'unknown'}`,
      );
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    // ── Image upload ────────────────────────────────────────────
    let imageFiles: QwenFileAttachment[] = [];
    if (hasImages && accountEmail) {
      const MAX_CONCURRENT = 2;
      for (let i = 0; i < imageUrls.length; i += MAX_CONCURRENT) {
        const batch = imageUrls.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(
          batch.map((url) =>
            uploadImageAsFile(accountEmail, url).catch((err: any) => {
              logStore.log('warn', 'chat', `[${label}] Image upload failed: ${err.message}`);
              return null;
            }),
          ),
        );
        imageFiles.push(...results.filter((f): f is QwenFileAttachment => f !== null));
      }
      if (imageFiles.length === 0) {
        throw new Error('Failed to upload images — none of the image files could be uploaded');
      }
    }

    // ── Context file upload ──────────────────────────────────────
    if (accountEmail && (systemContent || toolResultsContent || chatHistoryContent)) {
      const parts: string[] = [];
      if (systemContent) parts.push(`<system-instructions>\n${systemContent}\n</system-instructions>`);
      if (toolResultsContent) parts.push(`<tool-results>\n${toolResultsContent}\n</tool-results>`);
      if (chatHistoryContent) parts.push(`<chat_history>\n${chatHistoryContent}\n</chat_history>`);
      try {
        const file = await uploadLargeTextAsFile(accountEmail, parts.join('\n\n'), 'context.txt');
        processedMessages[0] = { ...processedMessages[0], files: [file] };
      } catch (err: any) {
        logStore.log('debug', 'chat', `[${label}] Failed to upload context file: ` + (err.message || err));
      }
    }

    if (imageFiles.length > 0) {
      processedMessages[0] = {
        ...processedMessages[0],
        files: [...(processedMessages[0].files || []), ...imageFiles],
      };
    }

    // ── Session acquire ──────────────────────────────────────────
    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        'warn',
        'chat',
        `[${label}] Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(logId, `Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;
    logStore.log('debug', 'chat', `[${label}] Session acquired: ${resolvedEmail} chatId=${session.chatId}`);
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    // ── Stream creation ──────────────────────────────────────────
    let streamResult;
    try {
      const routedModel = await modelRouter.route(body.model);
      streamResult = await createQwenStreamWithRetry(
        sessionMessages,
        isThinkingModel,
        routedModel,
        session.chatId,
        nextParentId,
        resolvedEmail,
        body.tools,
        body.tool_choice,
      );
    } catch (err: any) {
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      logStore.log(
        'warn',
        'chat',
        `[${label}] Stream failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}) upstreamStatus=${err.upstreamStatus || 'none'} name=${err.name || 'Error'}`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);

      if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
        logStore.log('warn', 'chat', `[${label}]   -> rate-limited, trying next account`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      if (
        (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
        (err.message || '').includes('CAPTCHA') ||
        err instanceof RetryableQwenStreamError
      ) {
        logStore.log('warn', 'chat', `[${label}]   -> CAPTCHA/validation, throttling + trying next`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        continue;
      }
      if (
        err.name === 'AbortError' ||
        (err.message || '').includes('timed out') ||
        (err.message || '').includes('timeout') ||
        (err.message || '').includes('ETIMEDOUT') ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        logStore.log('warn', 'chat', `[${label}]   -> timeout, trying next account`);
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      logStore.log('error', 'chat', `[${label}]   -> non-retryable error, throwing`);
      throw err;
    }
    let { stream, abortController: qwenAbortController } = streamResult;

    // ── First-chunk timeout ──────────────────────────────────────
    const streamReader = stream.getReader();
    let firstChunk: any;
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      firstChunk = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          firstChunkTimer = setTimeout(
            () => reject(new Error(`No first chunk from ${resolvedEmail} within ${FIRST_CHUNK_MS / 1000}s`)),
            FIRST_CHUNK_MS,
          );
        }),
      ]);
    } catch (timeoutErr) {
      clearTimeout(firstChunkTimer);
      logStore.log('warn', 'chat', `[${label}] First-chunk timeout for ${resolvedEmail} (attempt ${attempt + 1})`);
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    // Reconstruct stream with first chunk prepended
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!firstChunk.done && firstChunk.value) controller.enqueue(firstChunk.value);
        try {
          while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    // ── Prompt logging ───────────────────────────────────────────
    const finalPrompt = sessionMessages
      .map((m: any) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n\n');
    logStore.updateEntry(logId, (entry) => {
      entry.promptToQwen = {
        systemPromptLength: 0,
        totalLength: finalPrompt.length,
        preview: finalPrompt.length > 1000 ? finalPrompt.substring(0, 1000) + '...' : finalPrompt,
      };
    });
    logStore.log('debug', 'chat', `[${label}] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return { sessionMessages, session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController };
  }

  throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
}
