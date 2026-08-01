import crypto from 'node:crypto';
import { Context } from 'hono';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import { getModelSpecs, handleImageModelFallback } from './modelSpecs.ts';
import { providerForModel } from './providerRegistry.ts';
// Side-effect imports — provider modules self-register with the registry at import time.
import './providerDeepSeek.ts';
import './providerGlm.ts';
import { handleQwen } from './providers/qwen/handler.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpersCore.ts';

const MAX_MESSAGE_SIZE = 10_000_000; // 10MB

async function parseRequestBody(c: Context) {
  const rawBody = await c.req.json();

  const validation = validateOpenAIRequest(rawBody);
  if (!validation.ok) {
    const err = new Error(validation.error!);
    (err as any).upstreamStatus = validation.status || 400;
    (err as any).type = 'invalid_request_error';
    (err as any).code = validation.code || 'invalid_request_error';
    throw err;
  }

  const body = validation.data as unknown as OpenAIRequest;

  // Per-message size validation
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
  await handleImageModelFallback(body, messages);
  const { maxContext, maxOutput } = await getModelSpecs(body);

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

export async function chatCompletions(c: Context) {
  const _requestStartTime = Date.now();
  try {
    const parsed = await parseRequestBody(c);
    const { body, toolCalling, cleanOutput, messages, contextCheck } = parsed;
    logStore.log(
      'debug',
      'chat',
      `[Chat] Request: model=${body.model} stream=${body.stream} msgs=${messages.length} tools=${body.tools?.length || 0}`,
    );

    if (!contextCheck.ok) {
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

    // Multi-provider routing
    const providerRoute = providerForModel(body.model);
    if (providerRoute) {
      logStore.log('info', 'chat', `[Chat] Routing model=${body.model} to provider=${providerRoute.prefix}`);
      // NOTE: must await — a bare `return promise` lets provider rejections
      // (e.g. DeepSeek's upstream hint errors) escape this try/catch and hit
      // Hono's default 500 handler instead of the JSON error below.
      return await providerRoute.handler(c, body);
    }

    // Default: Qwen provider
    return await handleQwen(c, body, contextCheck.availableTokens!);
  } catch (err: any) {
    console.error(`[Chat] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
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
