import { getQwenHeaders, getBasicHeaders } from './playwright.ts';
import { v4 as uuidv4 } from 'uuid';
import modelSpecs from '../models.json' with { type: 'json' };
import { withRetry } from '../utils/retry.ts';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;

  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;
let nativeToolsDisabled = false;
let disablingNativeToolsInProgress = false;

export async function setEnglishInstruction(): Promise<void> {
  try {
    const { headers } = await getQwenHeaders(false);
    const payload = {
      personalization: {
        name: "",
        description: "",
        instruction: "Always think and reason in English. Never use Chinese. All output must be in English.\n\n## OUTPUT RULES\n\n### ALWAYS DO\n1. Output tool calls as pure JSON: {\"name\": \"tool_name\", \"arguments\": {\"key\": \"value\"}}\n2. Keep \"name\" as a string and \"arguments\" as a JSON object\n3. Multiple tool calls on separate lines, one JSON per line\n4. Text answers as plain text — no special formatting\n5. Think internally — reasoning stays private\n\n### NEVER DO\n1. NEVER output <think>, </think>, <thinking>, <thought>, <tool_call>, <function_call> or any XML tags\n2. NEVER wrap tool calls in markdown fences or XML\n3. NEVER prefix answers with \"Thinking:\", \"I am evaluating\", \"Let me\", or reasoning text\n4. NEVER output \"arguments\" as a JSON string — must be an object\n5. NEVER output \"name\" as anything other than a string\n\n### CORRECT\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"file.txt\"}}\n{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}\n\n### WRONG\n<tool_call>{\"name\":\"read_file\",...}</tool_call>\n```json\\n{\"name\":\"read_file\",...}\\n```\nThinking: I should check...",
        enable_for_new_chat: true
      }
    };
    const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': uuidv4(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      console.log('[Qwen] English instruction set successfully.');
    } else {
      console.warn('[Qwen] Failed to set English instruction:', await response.text());
    }
  } catch (err: any) {
    console.error(`[Qwen] Error setting English instruction: ${err.message}`);
  }
}

export async function disableNativeTools(): Promise<void> {
  if (nativeToolsDisabled || disablingNativeToolsInProgress) {
    return;
  }
  disablingNativeToolsInProgress = true;

  try {
    const { headers } = await getQwenHeaders();
    
    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false
      }
    };

    console.log('[Qwen] Disabling native tools...');
    const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': uuidv4(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Qwen] Failed to disable native tools: ${response.status} - ${text}`);
    } else {
      console.log('[Qwen] Native tools disabled successfully.');
      nativeToolsDisabled = true;
    }
  } catch (err: any) {
    console.error(`[Qwen] Error disabling native tools: ${err.message}`);
  } finally {
    disablingNativeToolsInProgress = false;
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) { // 1 hour cache
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders();
  
  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': uuidv4(),
      'bx-v': bxV,
      'timezone': new Date().toString(),
      'source': 'web'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => {
      const id = (m.id as string).toLowerCase().replace(/\./g, '-');
      const specs = (modelSpecs as any)[id] || (modelSpecs as any)[id.replace(/-no-thinking$/, '')] || { max_context: 1000000, max_output: 65536, modalities: ['text'] };
      return {
        id: m.id,
        object: 'model',
        created: m.info?.created_at || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || 'qwen',
        context_window: specs.max_context,
        max_output_tokens: specs.max_output,
        modalities: specs.modalities,
      };
    });

    // Add -no-thinking versions for models that support thinking
    const extendedModels = [...models];
    for (const m of models) {
      extendedModels.push({
        ...m,
        id: `${m.id}-no-thinking`
      });
    }

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

export async function createQwenStream(
  prompt: string, 
  enableThinking: boolean, 
  modelId: string,
  chatId?: string,
  parentId?: string | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  const { headers } = await getQwenHeaders(false);
  const actualParentId: string | null = parentId !== undefined ? parentId : null;
  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const url = chatId 
    ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`
    : 'https://chat.qwen.ai/api/v2/chat/completions';

  const retryConfig = {
    maxRetries: process.env.RETRY_MAX_ATTEMPTS !== undefined 
      ? Math.max(0, parseInt(process.env.RETRY_MAX_ATTEMPTS, 10)) 
      : 2,
    baseDelayMs: process.env.RETRY_BASE_DELAY_MS !== undefined 
      ? Math.max(0, parseInt(process.env.RETRY_BASE_DELAY_MS, 10)) 
      : 500,
    maxDelayMs: process.env.RETRY_MAX_DELAY_MS !== undefined 
      ? Math.max(0, parseInt(process.env.RETRY_MAX_DELAY_MS, 10)) 
      : 10000,
    backoffMultiplier: process.env.RETRY_BACKOFF_MULTIPLIER !== undefined 
      ? Math.max(0.1, parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER)) 
      : 2,
  };

  // Check if retries are explicitly disabled
  const retriesEnabled = process.env.RETRY_ENABLED !== 'false';

  const makeRequest = async (): Promise<{ response: Response; headers: Record<string, string> }> => {
    const { headers: reqHeaders } = await getQwenHeaders(false);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        'cookie': reqHeaders['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': chatId ? `https://chat.qwen.ai/c/${chatId}` : 'https://chat.qwen.ai/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'timezone': new Date().toString().split(' (')[0],
        'user-agent': reqHeaders['user-agent'],
        'x-accel-buffering': 'no',
        'x-request-id': uuidv4(),
        'bx-ua': reqHeaders['bx-ua'],
        'bx-umidtoken': reqHeaders['bx-umidtoken'],
        'bx-v': reqHeaders['bx-v']
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        try {
          const errorJson = JSON.parse(errText);
          if (errorJson?.data?.details?.includes('chat is in progress') ||
              errorJson?.data?.details?.includes('The chat is in progress')) {
            const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
            throw new RetryableQwenStreamError(
              `Qwen: ${errorJson.data.details}`,
              retryAfterMs,
            );
          }
          if (errorJson?.success === false) {
            const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
            const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
            const wait = errorJson.data?.num !== undefined
              ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
              : '';
            let status: number;
            if (code === 'RateLimited') status = 429;
            else if (code === 'Not_Found') status = 404;
            else if (code === 'UpstreamError') status = 502;
            else status = 502;
            throw new QwenUpstreamError(
              `Qwen upstream error: ${code}: ${details}.${wait}`,
              code,
              status,
            );
          }
          if (errorJson?.data?.details?.includes('is not exist') ||
              errorJson?.data?.details?.includes('not exist') ||
              errorJson?.data?.details?.includes('does not exist')) {
            throw new RetryableQwenStreamError(
              `Qwen: ${errorJson.data.details}`,
              0,
            );
          }
        } catch (parseOrRetryError) {
          if (parseOrRetryError instanceof RetryableQwenStreamError ||
              parseOrRetryError instanceof QwenUpstreamError) {
            throw parseOrRetryError;
          }
        }
      }

      const err = new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
      (err as any).status = response.status;
      throw err;
    }

    return { response, headers: reqHeaders };
  };

  let result: { response: Response; headers: Record<string, string> };

  if (retriesEnabled && retryConfig.maxRetries > 0) {
    result = await withRetry(makeRequest, retryConfig);
  } else {
    result = await makeRequest();
  }

  if (!result.response.body) {
    throw new Error(`Qwen returned empty response body (status ${result.response.status})`);
  }

  return { stream: result.response.body, headers: result.headers, uiSessionId: chatId || '' };
}