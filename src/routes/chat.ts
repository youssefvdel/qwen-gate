import crypto from 'node:crypto';
import { Context } from 'hono';
import { pickAccount, throttleAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import type { QwenFileAttachment } from '../services/qwenFileUpload.ts';
import { uploadImageAsFile, uploadLargeTextAsFile } from '../services/qwenFileUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  getModelSpecs,
  handleImageModelFallback,
} from './chatHelpers.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handleStreamingRequest } from './chatStreaming.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpers.ts';

const MAX_MESSAGE_SIZE = 10_000_000; // 10MB — large payloads are uploaded as files via Qwen's file API

async function parseRequestBody(c: Context) {
  const rawBody = await c.req.json();

  // Schema validation via zod — catches malformed requests early
  const validation = validateOpenAIRequest(rawBody);
  if (!validation.ok) {
    const err = new Error(validation.error!);
    (err as any).upstreamStatus = validation.status || 400;
    (err as any).type = 'invalid_request_error';
    (err as any).code = validation.code || 'invalid_request_error';
    throw err;
  }

  const body = validation.data as unknown as OpenAIRequest;

  // Per-message size validation to prevent OOM during estimateTokens
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (content && content.length > MAX_MESSAGE_SIZE) {
        const err = new Error(`Message content exceeds maximum size of ${MAX_MESSAGE_SIZE} characters`);
        (err as any).upstreamStatus = 400;
        (err as any).type = 'invalid_request_error';
        (err as any).code = 'message_too_large';
        throw err;
      }
    }
  }

  let isStream = body.stream ?? false;
  const streamMode = config.get('STREAMING_MODE', 'auto');
  if (streamMode === 'stream') isStream = true;
  else if (streamMode === 'non-stream') isStream = false;
  const toolCalling = config.getBool('TOOL_CALLING', true);
  const cleanOutput = config.getBool('CLEAN_OUTPUT', true);

  const messages = body.messages || [];
  handleImageModelFallback(body, messages);
  const { maxContext, maxOutput } = getModelSpecs(body);

  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n') : String(m.content ?? ''),
  }));
  const estimatedTokens = estimateTokens(formattedMessages.map((m) => m.content).join('\n'));
  const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model as string, formattedMessages);

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
    contextCheck,
    availableTokens: contextCheck.availableTokens,
  };
}

async function setupSession(messages: any[], body: OpenAIRequest, availableTokens: number, toolCalling: boolean, logId: string) {
  // ── Image detection ──────────────────────────────────────────
  // Scan messages for image_url parts — upload happens inside retry loop with account email
  let hasImages = false;
  const imageUrls: string[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type === 'image_url' && part?.image_url?.url) {
        hasImages = true;
        imageUrls.push(part.image_url.url);
      }
    }
  }

  // Strip image_url parts from messages (keep only text parts)
  // so buildQwenMessages doesn't serialize them as JSON text
  let cleanedMessages = messages;
  if (hasImages) {
    cleanedMessages = messages.map((msg: any) => {
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

  // File upload happens inside retry loop using the same account as the request
  // (accounts can't access files uploaded by other accounts — must share the account)
  let lastFailedEmail: string | undefined;

  const isThinkingModel = !body.model.includes('no-thinking');
  const MAX_ACCOUNT_RETRIES = 5;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    const selectedAccount = await pickAccount(lastFailedEmail);
    const accountEmail = selectedAccount?.email;
    if (!selectedAccount && attempt > 0) {
      // On retry: if still no accounts, all are throttled — stop retrying
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    // Upload all images in parallel
    let imageFiles: QwenFileAttachment[] = [];
    if (hasImages && accountEmail) {
      const results = await Promise.all(
        imageUrls.map((url) =>
          uploadImageAsFile(accountEmail, url).catch((err: any) => {
            logStore.log('warn', 'chat', `[Chat] Image upload failed: ${err.message}`);
            return null;
          }),
        ),
      );
      imageFiles = results.filter((f): f is QwenFileAttachment => f !== null);
      if (imageFiles.length === 0) {
        throw new Error('Failed to upload images — none of the image files could be uploaded');
      }
    }

    // Upload a single context file containing system instructions + tool results
    // Merging cuts upload overhead in half (one STS token, one OSS upload, one parse poll)
    if (accountEmail && (systemContent || toolResultsContent)) {
      const parts: string[] = [];
      if (systemContent) parts.push(`<system-instructions>\n${systemContent}\n</system-instructions>`);
      if (toolResultsContent) parts.push(`<tool-results>\n${toolResultsContent}\n</tool-results>`);
      const combinedContent = parts.join('\n\n');
      try {
        const file = await uploadLargeTextAsFile(accountEmail, combinedContent, 'context.txt');
        processedMessages[0] = { ...processedMessages[0], files: [file] };
      } catch (err: any) {
        logStore.log('debug', 'chat', '[Chat] Failed to upload context file: ' + (err.message || err));
      }
    }

    // Attach uploaded images to the first message
    if (imageFiles.length > 0) {
      processedMessages[0] = {
        ...processedMessages[0],
        files: [...(processedMessages[0].files || []), ...imageFiles],
      };
    }

    // Switch to vision chat type when images are present
    if (hasImages && imageFiles.length > 0) {
      processedMessages[0] = {
        ...processedMessages[0],
        chat_type: 't2v',
        sub_chat_type: 't2v',
        extra: { meta: { subChatType: 't2v' } },
      };
    }

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        'warn',
        'chat',
        `[Chat] Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(logId, `Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // Try next account
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;

    // Populate the account that served this request
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    let routedModel;
    let streamResult;
    try {
      routedModel = await modelRouter.route(body.model);
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
      // Release the acquired session to prevent pool exhaustion + inFlight leak
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      logStore.log(
        'debug',
        'chat',
        `[Chat] Request failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);

      // If rate limited, try next account — Qwen didn't process the request yet
      if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // Bot detection / CAPTCHA: Qwen rejected BEFORE processing (safe to retry on another account).
      // Throttle the detected account so pickAccount won't pick it again.
      if (
        (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
        (err.message || '').includes('CAPTCHA') ||
        err instanceof RetryableQwenStreamError
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        continue;
      }
      // Timeout / slow response: Qwen didn't respond in time — skip to next account without penalty
      if (
        err.name === 'AbortError' ||
        (err.message || '').includes('timed out') ||
        (err.message || '').includes('timeout') ||
        (err.message || '').includes('ETIMEDOUT') ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // All other errors (network, session): Qwen may have processed the request.
      // Don't throttle — let the user retry manually.
      throw err;
    }
    let { stream, abortController: qwenAbortController } = streamResult;

    // First-chunk timeout: Qwen sometimes sends HTTP headers but never body data (silent hang).
    // Wait up to 60s for the first byte. If none arrives, release this session and try next account.
    const FIRST_CHUNK_MS = 60_000;
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
      logStore.log(
        'warn',
        'chat',
        `[Chat] First-chunk timeout for ${resolvedEmail} after stream started (${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    // Reconstruct stream with the first chunk prepended, then pipe remaining data through.
    // This lets us keep the first chunk (already read) while allowing async consumption.
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

    // Build finalPrompt for logStore debug logging only
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

    logStore.log('debug', 'chat', `[Chat] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return {
      sessionMessages,
      session,
      nextParentId,
      sessionHeaders,
      resolvedEmail,
      stream,
      qwenAbortController,
    };
  }

  // All account retries exhausted — throw a clean user-facing error
  throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
}

function populateLogEntry(logEntry: any, body: OpenAIRequest, messages: any[]): void {
  const rawContent = messages.length > 0 ? messages[messages.length - 1].content : '';
  const lastMsg = typeof rawContent === 'string' ? rawContent : rawContent !== undefined ? JSON.stringify(rawContent) : '';
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
    tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
    lastMessage: lastMsg.substring(0, 300),
    messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } = parsed;
    logStore.log(
      'debug',
      'chat',
      `[Chat] Request: model=${body.model} stream=${isStream} msgs=${messages.length} tools=${body.tools?.length || 0} msgSizes=[${messages.map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length}`).join(',')}]`,
    );
    logStore.createEntry(logId, body.model, isStream);
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    if (!contextCheck.ok) {
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'context_window_exceeded';
      });
      logStore.finalizeRequest(logId);
      return c.json(
        {
          error: {
            message: contextCheck.message,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_window_exceeded',
          },
        },
        400,
      );
    }

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupSession(
      messages,
      body,
      contextCheck.availableTokens!,
      toolCalling,
      logId,
    );

    const completionId = 'chatcmpl-' + crypto.randomUUID();

    if (!isStream) {
      return handleNonStreamingRequest({
        c,
        logId,
        completionId,
        body,
        session,
        stream,
        resolvedEmail,
        initialParentId: nextParentId,
        sessionHeaders,
        toolCalling,
        cleanOutput,
      });
    }

    return await handleStreamingRequest({
      c,
      logId,
      completionId,
      body,
      session,
      stream,
      qwenAbortController,
      resolvedEmail,
      initialParentId: nextParentId,
      sessionHeaders,
      toolCalling,
      cleanOutput,
    });
  } catch (err: any) {
    console.error(`[Chat] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    logStore.finalizeRequest(logId);

    // Rate limit errors after all accounts exhausted — clean user-facing message
    if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
      return c.json(
        {
          error: {
            message: 'All accounts have reached their daily usage limit. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        429,
      );
    }

    const status = err.upstreamStatus || 500;
    const cleanMessage = cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || 'Internal error';
    return c.json(
      {
        error: {
          message: cleanMessage,
          type: err.type || 'server_error',
          code: err.code || undefined,
        },
      },
      status,
    );
  }
}
