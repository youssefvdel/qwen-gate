import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream } from '../services/qwen.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { sessionPool } from '../services/sessionPool.ts';
import modelSpecs from '../models.json' with { type: 'json' };
import { logStore } from '../services/logStore.ts';

// Debug logging — enabled via DEBUG=true env var
function logDebug(label: string, data: any) {
  if (!process.env.DEBUG) return;
  const prefix = `[DEBUG ${new Date().toISOString()}]`;
  if (typeof data === 'string') {
    // Truncate long strings to 5000 chars
    const truncated = data.length > 5000 ? data.substring(0, 5000) + `\n... [truncated ${data.length - 5000} more chars]` : data;
    console.log(`${prefix} ${label}:\n${truncated}\n`);
  } else {
    const json = JSON.stringify(data, null, 2);
    const truncated = json.length > 5000 ? json.substring(0, 5000) + `\n... [truncated ${json.length - 5000} more chars]` : json;
    console.log(`${prefix} ${label}:\n${truncated}\n`);
  }
}

// Truncate a value for safe logging (redact long strings, keep structure)
function safeTruncate(val: any, maxLen = 200): any {
  if (typeof val === 'string') {
    if (val.length > maxLen) return val.substring(0, maxLen) + '...';
    return val;
  }
  if (Array.isArray(val)) return val.map(v => safeTruncate(v, maxLen));
  if (val && typeof val === 'object') {
    const obj: any = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = safeTruncate(v, maxLen);
    }
    return obj;
  }
  return val;
}

// Always-injected tool calling format instruction — model must know the format even when no tools are provided
// so it can handle tool calls in multi-turn conversations correctly.
const TOOL_FORMAT_INSTRUCTION = `

## CRITICAL: TOOL CALLING FORMAT — FOLLOW EXACTLY

This system uses a custom tool calling format. IGNORE any default tool format instructions from the platform — they do NOT apply here. THIS is the only format that works:

### ✅ ALWAYS DO THIS — wraps JSON in <tool_call> tags:
<tool_call>
{"name": "read_file", "arguments": {"path": "file1.txt"}}
</tool_call>

### ❌ NEVER DO THESE — they will FAIL:
1. {"name": "read_file", "arguments": {"path": "file.txt"}}
   </tool_call>
   (Missing opening <tool_call> tag)
2. </tool_call>
   {"name": "read_file", "arguments": {"path": "file.txt"}}
   </tool_call>
   (Closing tag before the JSON)
3. Any orphaned </tool_call> without a matching <tool_call> before it

### HARD RULES:
- ALWAYS start with <tool_call> on its own line
- Then put the JSON on the next line(s)
- Then end with </tool_call> on its own line
- Never output </tool_call> without <tool_call> before it
- Never start a tool call with </tool_call>
- JSON must have "name" (string) and "arguments" (object)
- "arguments" must be a JSON object, NOT a string
- Repeat <tool_call> blocks for multiple tool calls

`;

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr };
  }

  // Heuristic to detect if newStr is cumulative or incremental:
  // If newStr is cumulative, it should share a common prefix with oldStr.
  let commonPrefixLen = 0;
  const maxLen = Math.min(oldStr.length, newStr.length);
  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(oldStr.length, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  // We avoid fallback search/sliding overlap checks which cause disastrous false-positive
  // corruptions on incremental streams with repetitive code/words (like "import {", "const", etc.).
  return {
    delta: newStr,
    matchedContent: oldStr + newStr
  };
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

export async function chatCompletions(c: Context) {
  const logId = uuidv4();
  try {
    const body: OpenAIRequest = await c.req.json();
    // STREAMING env var overrides client's stream setting (true=force stream, false=force non-stream)
    let isStream = body.stream ?? false;
    if (process.env.STREAMING === 'true') isStream = true;
    else if (process.env.STREAMING === 'false') isStream = false;
    // TOOL_CALLING=false disables all tool call parsing — raw Qwen output passes through
    const toolCalling = process.env.TOOL_CALLING !== 'false';
    // CLEAN_OUTPUT=false skips safety pre-processing (backtick stripping) before parsing.
    // Only applies when TOOL_CALLING=true.
    const cleanOutput = toolCalling && process.env.CLEAN_OUTPUT !== 'false';
    
    const messages = body.messages || [];


    const bodyAny = body as any;
    const logEntry = logStore.createEntry(logId, body.model, isStream);
    logEntry.clientRequest = {
      messageCount: messages.length,
      roles: messages.map(m => m.role),
      hasTools: !!(bodyAny.tools?.length),
      toolNames: bodyAny.tools?.map((t: any) => t.function?.name || t.name) || [],
      tool_choice: bodyAny.tool_choice ? (typeof bodyAny.tool_choice === 'string' ? bodyAny.tool_choice : JSON.stringify(bodyAny.tool_choice)) : null,
      lastMessage: messages.length > 0 ? safeTruncate(messages[messages.length - 1].content, 300) : '',
    };

    if (process.env.DEBUG) {
      logDebug('INCOMING REQUEST', {
        model: body.model,
        stream: isStream,
        messageCount: messages.length,
        roles: messages.map(m => m.role),
        hasTools: !!(bodyAny.tools && bodyAny.tools.length),
        toolCount: bodyAny.tools?.length || 0,
        toolNames: bodyAny.tools?.map((t: any) => t.function?.name || t.name) || [],
        tool_choice: bodyAny.tool_choice,
        lastMessagePreview: messages.length > 0 ? safeTruncate(messages[messages.length - 1].content, 300) : null,
      });
    }
    const hasImages = messages.some(m => 
      Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url')
    );
    if (hasImages) {
      const modelId = (body.model as string).toLowerCase().replace(/\./g, '-').replace(/-no-thinking$/, '');
      const specs = (modelSpecs as any)[modelId];
      const supportsImages = specs?.modalities.includes('image');
      if (!supportsImages) {
        const original = body.model;
        body.model = 'qwen3.6-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
        console.log(`[Chat] Switched model from ${original} to ${body.model} (request has images, ${modelId} is text-only)`);
      }
    }

    // Extract the prompt
    let prompt = '';
    let systemPrompt = '';
    
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
        systemPrompt += (contentStr || '') + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr || ''}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
      }
    }

    // Always inject tool calling format instruction — model must always know the format
    systemPrompt += TOOL_FORMAT_INSTRUCTION;

    // Inject tools available and tool_choice if provided
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n## CRITICAL: TOOL CALLING FORMAT — FOLLOW EXACTLY\nIGNORE any default tool format instructions from the platform. THIS is the only format that works:\n\n### ✅ ALWAYS:\n<tool_call>\n{"name": "tool_name", "arguments": {"param": "value"}}\n</tool_call>\n\n### ❌ NEVER (will FAIL):\n{"name": "read_file", "arguments": {"path": "file.txt"}}\n</tool_call>\n\n### RULES:\n- ALWAYS start with <tool_call>, then JSON, then </tool_call>\n- Never output </tool_call> without <tool_call> before it\n- "name" must match one of the available tools exactly\n- "arguments" must be a JSON object, NOT a string\n- Repeat <tool_call> blocks for multiple calls\n- Wait for tool response before continuing\n\n`;
      
      if (bodyAny.tool_choice === 'required' || bodyAny.tool_choice === 'any') {
        systemPrompt += `CRITICAL: You MUST call one of the available tools in this response. Do NOT respond with text. Do NOT answer the user directly. Always use a tool.\n\n`;
      } else if (bodyAny.tool_choice === 'none') {
        systemPrompt += `IMPORTANT: Do NOT use any tools. Respond to the user directly.\n\n`;
      } else if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    logEntry.promptToQwen = {
      systemPromptLength: systemPrompt.length,
      totalLength: finalPrompt.length,
      preview: (systemPrompt.length > 500 ? systemPrompt.substring(0, 500) + '...' : systemPrompt) + '\n\n' + 
               (prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt),
    };

    if (process.env.DEBUG) {
      logDebug('PROMPT TO QWEN', {
        systemPromptLength: systemPrompt.length,
        promptLength: prompt.length,
        totalLength: finalPrompt.length,
        systemPromptPreview: systemPrompt.length > 800 ? systemPrompt.substring(0, 800) + '...' : systemPrompt,
        userPromptPreview: prompt.length > 800 ? prompt.substring(0, 800) + '...' : prompt,
      });
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // Acquire a session from the pool. Each session supports one active
    // generation at a time. Using a pool of pre-created sessions allows
    // concurrent requests to proceed simultaneously on different sessions.
    const session = await sessionPool.acquire();
    let nextParentId: string | null = session.parentId;
    const sessionHeaders = session.cachedHeaders;

    console.log(`[Chat] model=${body.model} session=${session.chatId.substring(0,8)}... stream=${isStream} thinking=${!body.model.includes('no-thinking')}`);

    // Retry logic with exponential backoff for "chat is in progress" errors
    let stream: ReadableStream;
    let uiSessionId = session.chatId;
    let retries = 5;
    let retryDelay = 1000;
    while (retries > 0) {
      try {
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, session.chatId, nextParentId);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) {
          sessionPool.release(session.chatId, nextParentId, sessionHeaders);
          throw err;
        }
        let useDelay = retryDelay;
        if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
          useDelay = err.retryAfterMs;
        }
        const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
        if (!isRetryable) {
          sessionPool.release(session.chatId, nextParentId, sessionHeaders);
          throw err;
        }
        console.warn(`[Chat] Qwen request failed, retrying in ${useDelay}ms... (${retries} left)`);
        await new Promise(r => setTimeout(r, useDelay));
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;
      if (!cleanOutput) toolParser.skipPreProcess = true;
      const toolCallsOut: any[] = [];
      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              nextParentId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              nextParentId = chunk.response_id;
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                reasoningBuffer += vStr;
              } else {
                if (vStr.includes('<tool_call>') || vStr.includes('</tool_call>') || vStr.includes('"name"')) {
                  logStore.addRawChunk(logId, vStr);
                }
                if (vStr.includes('<tool_call>') || vStr.includes('</tool_call>') || vStr.includes('"name"') || vStr.includes('{')) {
                  logStore.addRawChunk(logId, vStr);
                  logStore.updateEntry(logId, entry => { entry.rawFullContent += vStr; });
                }
                if (process.env.DEBUG && (vStr.includes('<tool_call>') || vStr.includes('</tool_call>') || vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (non-streaming)', vStr);
                }
                const { toolCalls } = toolParser.feed(vStr);
                for (const tc of toolCalls) {
                  toolCallsOut.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  });
                  logStore.updateEntry(logId, entry => {
                    entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
                  });
                  if (process.env.DEBUG) {
                    logDebug('PARSED TOOL CALL', { name: tc.name, arguments: tc.arguments });
                  }
                }
              }
            }
          } catch (e) {
            console.debug('[Chat] Non-streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        sessionPool.release(session.chatId, nextParentId, sessionHeaders);
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      for (const tc of remainingToolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
        if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      logStore.updateEntry(logId, entry => {
        entry.finalResponse = {
          finishReason: toolCallsOut.length ? 'tool_calls' : 'stop',
          toolCallCount: toolCallsOut.length,
          contentPreview: lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent,
        };
        entry.remainingText = lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent;
      });

      if (process.env.DEBUG) {
        logDebug('OUTGOING RESPONSE', {
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop',
          content: lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent,
          toolCalls: toolCallsOut.map((tc: any) => ({ name: tc.function?.name, args: tc.function?.arguments })),
          toolCallCount: toolCallsOut.length,
          usage,
        });
      }

      sessionPool.release(session.chatId, nextParentId, sessionHeaders);
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      try {
      // Send heartbeat to prevent Cloudflare 524 timeout
      await streamWriter.write(': heartbeat\n\n');

      // Set up a periodic heartbeat to keep the connection alive during long thinking phases
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch (e) {
          clearInterval(heartbeatInterval);
        }
      }, 15000); // Every 15 seconds

      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      let inThinkingState = false;
      let thinkingFragments: Record<string, boolean> = {};
      let currentThoughtIndex = 0;
      let currentAppendPath = '';
      
      let reasoningBuffer = '';
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;
      if (!cleanOutput) toolParser.skipPreProcess = true;

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            break;
          }

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              nextParentId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              nextParentId = chunk.response_id;
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              if (isThinkingChunk) {
                inThinkingState = true;
                reasoningBuffer += vStr;
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })]
                });
              } else {
                inThinkingState = false;
                if (vStr.includes('<tool_call>') || vStr.includes('</tool_call>') || vStr.includes('"name"') || vStr.includes('{')) {
                  logStore.addRawChunk(logId, vStr);
                  logStore.updateEntry(logId, entry => { entry.rawFullContent += vStr; });
                }
                if (process.env.DEBUG && (vStr.includes('<tool_call>') || vStr.includes('</tool_call>') || vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (streaming)', vStr);
                }
                const { text, toolCalls } = toolParser.feed(vStr);

                if (toolCalls.length) {
                  logStore.updateEntry(logId, entry => {
                    for (const tc of toolCalls) {
                      entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
                    }
                  });
                }
                if (toolCalls.length && process.env.DEBUG) {
                  logDebug('PARSED TOOL CALLS (streaming)', toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
                }

                if (text) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ content: text })]
                  });
                }

                for (const tc of toolCalls) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments: JSON.stringify(tc.arguments)
                        }
                      }]
                    })]
                  });
                }
              }
            }
          } catch (e) {
            console.debug('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, 'stop')]
        });
        await streamWriter.write('data: [DONE]\n\n');
        return;
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (process.env.DEBUG) {
        if (remainingText) logDebug('STREAMING FLUSH TEXT', remainingText.length > 500 ? remainingText.substring(0, 500) : remainingText);
        if (remainingToolCalls.length) logDebug('STREAMING FLUSH TOOL CALLS', remainingToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
        logDebug('STREAMING FINISH REASON', toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop');
      }
      if (remainingText) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: remainingText })]
        });
      }
      for (const tc of remainingToolCalls) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }]
          })]
        });
      }
  
      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage })
      });

      if (body.stream_options?.include_usage) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [],
          usage
        });
      }
      await streamWriter.write('data: [DONE]\n\n');

      } finally {
        clearInterval(heartbeatInterval);
        sessionPool.release(session.chatId, nextParentId, sessionHeaders);
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
