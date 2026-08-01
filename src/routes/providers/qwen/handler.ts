/*
 * File: providers/qwen/handler.ts
 * Qwen provider handler — end-to-end handling of Qwen chat completions.
 *
 * Called from chatCompletions as the default fallback for unprefixed model names.
 * Owns: provider handler that routes to streaming/non-streaming via shared session setup.
 */

import crypto from 'node:crypto';
import type { Context } from 'hono';
import { config } from '../../../services/configService.ts';
import { logStore } from '../../../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../../../tools/xmlToolParser.ts';
import type { OpenAIRequest } from '../../../types/openai.ts';
import { registerProvider } from '../../providerRegistry.ts';
import { handleNonStreamingRequest } from './pipeline-nonstream.ts';
import { handleStreamingRequest } from './pipeline-stream.ts';
import { setupSession } from './session.ts';

// ── Provider handler ─────────────────────────────────────────────────────

export async function handleQwen(c: Context, body: OpenAIRequest, availableTokens: number): Promise<Response> {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();
  try {
    const toolCalling = config.getBool('TOOL_CALLING', true);
    const cleanOutput = config.getBool('CLEAN_OUTPUT', true);
    const isStream = body.stream ?? false;
    const messages = body.messages || [];

    logStore.log('debug', 'chat', `[Qwen] model=${body.model} stream=${isStream} msgs=${messages.length}`);
    logStore.createEntry(logId, body.model, isStream);
    logStore.updateEntry(logId, (entry) => {
      entry.apiType = 'openai';
    });

    // Client request logging
    const rawContent = messages.length > 0 ? messages[messages.length - 1].content : '';
    const lastMsg = typeof rawContent === 'string' ? rawContent : rawContent !== undefined ? JSON.stringify(rawContent) : '';
    logStore.updateEntry(logId, (entry) => {
      entry.clientRequest = {
        messageCount: messages.length,
        roles: messages.map((m: any) => m.role),
        hasTools: !!body.tools?.length,
        toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
        tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
        lastMessage: lastMsg.substring(0, 300),
        messages: messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      };
    });

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupSession(
      messages,
      body,
      availableTokens,
      toolCalling,
      logId,
      'Qwen',
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
    console.error(`[Qwen] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
    logStore.addError(logId, err.message || String(err));
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    logStore.finalizeRequest(logId);

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
    return c.json({ error: { message: cleanMessage, type: err.type || 'server_error', code: err.code || undefined } }, status);
  }
}

/**
 * Handler wrapper for registered provider interface (strips qwen/ prefix).
 * Register Qwen as a prefixed provider so qwen/qwen-max works alongside glm/glm-4.7.
 */
export const qwenProviderHandler: import('../../providerRegistry.ts').ProviderHandler = async (c, body) => {
  // Strip qwen/ prefix, keep the original model name for internal dispatch
  const model = body.model.replace(/^qwen\//, '');
  // Await so any rejection is caught by this provider's own error handling
  // (bare `return promise` would let it escape to the route's catch/Hono 500).
  return await handleQwen(c, { ...body, model }, 0);
};
registerProvider('qwen/', qwenProviderHandler);
