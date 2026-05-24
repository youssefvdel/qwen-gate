import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream } from '../services/qwen.ts';
import { OpenAIRequest, Message } from '../utils/types.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { filterContent, stripToolCallArtifacts } from '../utils/contentFilter.ts';
import { sessionPool } from '../services/sessionPool.ts';
import modelSpecs from '../models.json' with { type: 'json' };
import { logStore } from '../services/logStore.ts';
import { pickAccount, getAccountStats } from '../services/auth.ts';

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

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return '';
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return '';
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Robust cumulative chunk detection. Qwen sometimes sends the full growing text
 * in each chunk instead of incremental deltas. Prefix-only detection fails when
 * the filter reclassifies early content (changing the prefix). This fallback
 * checks if the new text contains the old text as a substring — if yes, it's
 * cumulative and we extract the delta from the end.
 *
 * Returns: { cumulative: boolean, delta: string }
 *   - cumulative=true: newText contains lastText, delta is the new tail
 *   - cumulative=false: treat as incremental or duplicate
 */
export function detectCumulativeChunk(
  newText: string,
  lastText: string
): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };

  // Fast path: exact duplicate or subset
  if (newText === lastText || lastText.startsWith(newText)) {
    return { cumulative: false, delta: '' };
  }

  // Fast path: clean prefix match (existing behavior)
  const prefixLen = commonPrefixLen(newText, lastText);
  if (prefixLen >= Math.min(8, lastText.length) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  // Fallback: suffix containment — does newText contain lastText anywhere?
  // This handles the case where filter reclassified early content, changing the prefix,
  // but the bulk of lastText still appears in newText.
  if (newText.length > lastText.length && lastText.length >= 16) {
    // Use the LAST 64 chars of lastText as a fingerprint (avoid short false matches)
    const fingerprint = lastText.slice(-Math.min(64, lastText.length));
    const idx = newText.indexOf(fingerprint);
    if (idx !== -1) {
      // Found the fingerprint. The delta is everything after the end of where
      // lastText would end if it appeared at this position.
      const expectedEnd = idx + lastText.length;
      if (expectedEnd <= newText.length) {
        // Verify: check that newText starting at idx matches lastText closely enough
        // (allow for filter reclassification at the very start, up to 200 chars divergence)
        const candidateRegion = newText.substring(idx, idx + lastText.length);
        const suffixMatch = commonSuffixLen(candidateRegion, lastText);
        if (suffixMatch >= Math.min(lastText.length * 0.7, lastText.length - 8)) {
          // 70%+ suffix match → it's cumulative
          const delta = newText.substring(expectedEnd);
          return { cumulative: true, delta };
        }
      }
    }
  }

  return { cumulative: false, delta: newText };
}

/**
 * Suffix-aware snapshot diff: if the filter reclassified early content (changing
 * the prefix), use the longest common SUFFIX to find what's genuinely new at
 * the end. Falls back to detectCumulativeChunk for robustness.
 */
function getSnapshotDelta(newSnapshot: string, lastSnapshot: string): string {
  if (!newSnapshot) return '';
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return '';

  if (newSnapshot.length <= lastSnapshot.length) {
    return '';
  }

  if (newSnapshot.startsWith(lastSnapshot)) {
    return newSnapshot.substring(lastSnapshot.length);
  }

  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;

  return '';
}

function cleanThinkTags(t: string): string {
  return t.replace(/<\/?(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, '');
}

// Always-injected tool calling format instruction — model must know the format even when no tools are provided
// so it can handle tool calls in multi-turn conversations correctly.
// HIGHEST PRIORITY: This is the #1 rule. Incorrect format breaks the streaming pipeline.
// Only the correct JSON format is shown. Never mention alternative formats —
// showing them teaches the model about them and increases the chance they get used.
const TOOL_FORMAT_INSTRUCTION = `
## OUTPUT RULES — HIGHEST PRIORITY

### CORRECT FORMAT
When calling a tool, output ONLY a single line of raw JSON:
{"name": "read_file", "arguments": {"path": "src/main.ts"}}
{"name": "glob", "arguments": {"pattern": "**/*.ts"}}
{"name": "bash", "arguments": {"command": "ls -la"}}

### RULES
1. "name" must be a plain string — the tool name
2. "arguments" must be a JSON object — not a string, not a number
3. Output each tool call on its own line, one JSON object per line
4. Output text answers as plain text with no special formatting
5. Your private reasoning is never shown to the user — answer directly
6. Do not prefix answers with "Thinking:", "I am", "Let me", or any reasoning text


### CRITICAL
Never wrap tool calls in fences or backticks.
Never output raw JSON with text around it.
This is the highest priority rule — incorrect format causes cascading failures.
`;

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
  else if (process.env.NON_STREAMING === 'true') isStream = false;
    // TOOL_CALLING=false disables all tool call parsing — raw Qwen output passes through
    const toolCalling = process.env.TOOL_CALLING !== 'false';
    // CLEAN_OUTPUT=false skips safety pre-processing (backtick stripping) before parsing.
    // Only applies when TOOL_CALLING=true.
    const cleanOutput = toolCalling && process.env.CLEAN_OUTPUT !== 'false';
    // CONTENT_FILTER=false disables thinking/XML stripping and space collapsing.
    // Set this if the content filter is too aggressive and removes content you want to keep.
    const contentFiltering = process.env.CONTENT_FILTER !== 'false';
    
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
        const sanitized = contentStr
          .replace(/<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi, '')
          .replace(/<(?:think|thinking|thought|tool_call|tool_use|function_call|tool)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, '')
          .replace(/^(?:System|Assistant|User|Human):\s*/gim, '')
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
        const truncated = sanitized.length > 32768
          ? sanitized.substring(0, 32768) + '\n\n[TRUNCATED: input exceeded 32768 characters]'
          : sanitized;
        prompt += `User: ${truncated || ''}\n\n`;
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
             const toolCallStr = JSON.stringify(payload);
             assistantContent = assistantContent ? assistantContent + '\n' + toolCallStr : toolCallStr;
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
        const truncated = (contentStr || '').length > 4096
          ? (contentStr || '').substring(0, 4096) + '\n[...truncated]'
          : (contentStr || '');
        prompt += `Tool Response (${toolName || 'tool'}): ${truncated}\n\n`;
      }
    }

    // Global anti-XML instruction — always inject when tool calling is enabled,
    // even without tools in the current request. Prevents the model from
    // outputting XML-wrapped tool calls from its training data.
    if (toolCalling) {
      systemPrompt += `\n\nCRITICAL: Never use XML tags (like ,) for tool calls or structured output. Always use plain JSON.\n\n`;
    }

    // Inject tools available and tool_choice if provided
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      if (toolCalling) systemPrompt += TOOL_FORMAT_INSTRUCTION;
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
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to:\n${toolsJson}\n\nIMPORTANT: When calling a tool, output ONLY raw JSON with no surrounding text:\n{"name": "tool_name", "arguments": {"param": "value"}}\n\nNever wrap tool calls in fences or backticks.\n\n`;
      
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
    
    // Pick the best available account (round-robin, non-throttled, least-recently-used)
    const selectedAccount = pickAccount();
    const accountEmail = selectedAccount?.email;

    // Acquire a session bound to the selected account. Each session supports one active
    // generation at a time. Multi-account rotation distributes rate limits.
    const session = await sessionPool.acquire(accountEmail);
    let nextParentId: string | null = session.parentId;
    const sessionHeaders = session.cachedHeaders;
    const resolvedEmail = session.accountEmail || accountEmail;

    const emailLabel = resolvedEmail ? ` account=${resolvedEmail.split('@')[0]}` : '';
    console.log(`[Chat] model=${body.model} session=${session.chatId.substring(0,8)}... stream=${isStream} thinking=${!body.model.includes('no-thinking')}${emailLabel}`);

    // Retry logic with exponential backoff for transient errors
    let stream: ReadableStream;
    let uiSessionId = session.chatId;
    try {
      const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, session.chatId, nextParentId, resolvedEmail);
      stream = result.stream;
      uiSessionId = result.uiSessionId;
      // Account may have rotated during retry (rate limit → switch account)
      if (result.accountEmail && result.accountEmail !== resolvedEmail) {
        console.log(`[Chat] Account rotated: ${resolvedEmail?.split('@')[0]} → ${result.accountEmail.split('@')[0]}`);
      }
    } catch (err: any) {
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
      throw err;
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
      const correctionPrompts: string[] = []; // Guard rejection messages for logging

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
                  const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
                  if (rawNew) {
                    const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
                    vStr = rawNew.substring(commonLen);
                    if (vStr) {
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  vStr = delta.content || '';
                  if (vStr) {
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
                // Log ALL raw chunks from Qwen, not just ones with JSON markers
                logStore.addRawChunk(logId, vStr);
                if (process.env.DEBUG && (vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (non-streaming)', vStr);
                }
                const { toolCalls, thinking, text: parserText } = toolParser.feed(vStr);
                if (thinking) {
                  reasoningBuffer += thinking;
                }
                // Accumulate parser-extracted text without per-chunk filtering.
                // Filtering happens once at the end to avoid over-filtering
                // content that looks like thinking in isolation but is clearly
                // answer content in context.
                // Cumulative detection: if parserText already contains lastFullContent
                // as prefix, it's a cumulative chunk — replace instead of append.
                if (parserText) {
                  if (lastFullContent.length > 0) {
                    const detection = detectCumulativeChunk(parserText, lastFullContent);
                    if (detection.cumulative) {
                      lastFullContent = parserText;
                    } else if (detection.delta === '') {
                      // Duplicate — skip
                    } else {
                      lastFullContent += parserText;
                    }
                  } else {
                    lastFullContent = parserText;
                  }
                }
                for (const tc of toolCalls) {
                  // Guard: validate tool call before sending to client
                  const guard = validateSingleToolCall(tc);
                  if (!guard.ok) {
                    console.warn(`[Guard] REJECTED tool call "${tc.name}":`, guard.errors);
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Guard rejected tool call "${tc.name}": ${guard.errors.join(', ')}`);
                    });
                    // Store correction prompt for next turn
                    correctionPrompts.push(guard.correctionPrompt);
                    continue; // Skip — don't send to client
                  }
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
        sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      if (remainingThinking) {
        reasoningBuffer += remainingThinking;
      }
      for (const tc of remainingToolCalls) {
        // Guard: validate tool call before sending to client
        const guard = validateSingleToolCall(tc);
        if (!guard.ok) {
          console.warn(`[Guard] REJECTED flush tool call "${tc.name}":`, guard.errors);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Guard rejected flush tool call "${tc.name}": ${guard.errors.join(', ')}`);
          });
          correctionPrompts.push(guard.correctionPrompt);
          continue;
        }
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
      const { cleanText: baseFilteredContent, thinking: filteredReasoning } = contentFiltering
        ? filterContent(lastFullContent)
        : { cleanText: lastFullContent, thinking: '' };
      if (filteredReasoning) {
        reasoningBuffer = reasoningBuffer ? reasoningBuffer + '\n' + filteredReasoning : filteredReasoning;
      }
      // Safety net: strip any remaining JSON tool calls or Tool Response echoes
      // from the content before sending to the client. This catches any tool
      // call artifacts that the streaming parser might have missed.
      const filteredContent = stripToolCallArtifacts(baseFilteredContent);
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : filteredContent };
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
        entry.processedApiOutput = filteredContent;
        if (correctionPrompts.length > 0) entry.errors.push(...correctionPrompts);
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

      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
      // Persist raw vs processed output for debugging
      const logEntry = logStore.getRecent(1).find(e => e.id === logId);
      if (logEntry) logStore.persistRequest(logEntry);
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
    c.header('Connection', 'close'); // Close TCP socket when response ends — don't keep alive

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      let totalChunks = 0;
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
      let lastRawContent = '';  // pre-parser cumulative tracking
      // Snapshot-based diffing: track the full filtered text from the previous
      // iteration rather than accumulating emitted deltas. This prevents the
      // exponential amplification bug where filterContent() reclassifying early
      // content (e.g., "I am analyzing..." → thinking) changes the prefix,
      // causing getNewContent() to re-emit the entire text as "new".
      let lastFilteredSnapshot = '';
      let lastThinkingSnapshot = '';
      // O(n²) → O(n) filter cache: only re-run filterContent() when lastFullContent
      // actually grows. Pure function on same input = same output, so cache is safe.
      let lastFilteredLength = -1;
      let cachedBaseFiltered = '';
      let cachedFilteredThinking = '';
      let cachedFullFilteredText = '';
      // Pre-parser cumulative tracking: detect cumulative vStr BEFORE feeding parser
      // to prevent parser buffer from growing quadratically.
      let lastVStrRaw = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;
      if (!cleanOutput) toolParser.skipPreProcess = true;

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let streamDone = false;

      // Amplification guard: track raw input bytes vs emitted output bytes.
      // If emitted > raw*3 + 1000, suppress further text emission.
      let rawInputBytes = 0;
      let emittedOutputBytes = 0;
      let amplificationGuardTriggered = false;

      while (true) {
        if (streamDone) break;
        if (c.req.raw?.signal?.aborted) { reader.cancel(); break; }

        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const readResult = await reader.read();
          done = readResult.done;
          value = readResult.value;
        } catch (readErr: any) {
          throw readErr;
        }

        if (done) {
          console.log(`[Chat] account=${resolvedEmail} chunks=${totalChunks} upstream stream ended`);
          break;
        }
        totalChunks++;
        if (value) rawInputBytes += value.length;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk.choices?.[0]?.delta?.status === 'finished') {
              const deltaPhase = chunk.choices[0].delta.phase;
              // 'thinking_summary' finished just means thinking is done — content (answer) comes next.
              if (deltaPhase !== 'thinking_summary') {
                streamDone = true;
                break;
              }
            }

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
                  const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
                  if (rawNew) {
                    const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
                    vStr = rawNew.substring(commonLen);
                    if (vStr) {
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  vStr = delta.content || '';
                  if (vStr) {
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
                // Strip stray tag closers that arrive as separate chunks after the
                // content has been parsed.
                if (/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/.test(vStr)) continue;

                // Log ALL raw chunks from Qwen, not just ones with JSON markers
                logStore.addRawChunk(logId, vStr);
                if (process.env.DEBUG && (vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (streaming)', vStr);
                }
                // Pre-parser cumulative detection on vStr: if vStr contains lastVStrRaw
                // as prefix or suffix, extract only delta to prevent parser buffer bloat.
                let feedStr = vStr;
                if (lastVStrRaw.length > 0) {
                  const detection = detectCumulativeChunk(vStr, lastVStrRaw);
                  if (detection.cumulative) {
                    feedStr = detection.delta;
                    lastVStrRaw = vStr;
                  } else if (detection.delta === '') {
                    // Duplicate vStr — skip parser feed entirely
                    feedStr = '';
                  } else {
                    // Incremental vStr
                    lastVStrRaw += vStr;
                  }
                } else {
                  lastVStrRaw = vStr;
                }
                const { text: rawText, toolCalls, thinking: parserThinking } = feedStr ? toolParser.feed(feedStr) : { text: '', toolCalls: [], thinking: '' };

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

                if (rawText) {
                  // Pre-parser cumulative detection: Qwen sometimes sends the full
                  // growing text in each chunk instead of incremental deltas.
                  // Detect this BEFORE accumulating into lastFullContent to prevent
                  // the parser buffer from growing quadratically.
                  if (lastRawContent.length > 0) {
                    const detection = detectCumulativeChunk(rawText, lastRawContent);
                    if (detection.cumulative) {
                      lastRawContent = rawText;
                      lastFullContent += detection.delta;
                    } else if (detection.delta === '') {
                      // Duplicate/retry — skip
                    } else {
                      // Incremental chunk
                      lastRawContent += rawText;
                      lastFullContent += rawText;
                    }
                  } else {
                    lastRawContent = rawText;
                    lastFullContent = rawText;
                  }
                }

                // Apply content filtering with O(n²) → O(n) cache: only re-run
                // filterContent() when lastFullContent length changes. Pure function
                // on same input = same output, so cache is safe.
                if (lastFullContent.length !== lastFilteredLength) {
                  const { cleanText, thinking } = (contentFiltering && lastFullContent)
                    ? filterContent(lastFullContent)
                    : { cleanText: lastFullContent || '', thinking: '' };
                  cachedBaseFiltered = cleanText;
                  cachedFilteredThinking = thinking;
                  cachedFullFilteredText = stripToolCallArtifacts(cleanText);
                  lastFilteredLength = lastFullContent.length;
                }
                const baseFilteredContent = cachedBaseFiltered;
                const filteredThinking = cachedFilteredThinking;
                const fullFilteredText = cachedFullFilteredText;

                // Emit parser-captured thinking first (from <think> tags)
                if (parserThinking) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ reasoning_content: parserThinking })]
                  });
                }

                // Snapshot-based thinking emission: compare full current thinking
                // against previous snapshot instead of accumulating deltas.
                if (filteredThinking) {
                  const thinkingDelta = getSnapshotDelta(filteredThinking, lastThinkingSnapshot);
                  lastThinkingSnapshot = filteredThinking;
                  if (thinkingDelta) {
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ reasoning_content: thinkingDelta })]
                    });
                  }
                }

                const pendingText = (toolCalls.length > 0 && fullFilteredText) ? fullFilteredText : null;
                const cleanedText = pendingText
                  ? cleanThinkTags(pendingText)
                  : (fullFilteredText ? cleanThinkTags(fullFilteredText) : null);

                // Snapshot-based content emission: compare full current filtered text
                // against previous snapshot. This is the key fix — even if the filter
                // reclassifies early content and changes the prefix, we only emit what
                // is genuinely new relative to the previous snapshot.
                if (cleanedText && !pendingText) {
                  const contentDelta = getSnapshotDelta(cleanedText, lastFilteredSnapshot);
                  lastFilteredSnapshot = cleanedText;
                  if (contentDelta) {
                    if (!amplificationGuardTriggered) {
                      const projectedRatio =
                        (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
                      if (projectedRatio > 3 && emittedOutputBytes > 1000) {
                        amplificationGuardTriggered = true;
                        const ratio = Math.round(projectedRatio * 100) / 100;
                        console.error(
                          `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x ` +
                          `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                          `account=${resolvedEmail} model=${body.model}`
                        );
                        logStore.recordAmplificationEvent(
                          logId,
                          ratio,
                          lastRawContent || lastVStrRaw || ''
                        );
                      }
                    }
                    if (amplificationGuardTriggered) {
                      continue;
                    }
                    logStore.addProcessedOutput(logId, contentDelta);
                    emittedOutputBytes += contentDelta.length;
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ content: contentDelta })]
                    });
                  }
                }

                let allToolCallsValid = true;
                for (const tc of toolCalls) {
                  // Guard: validate tool call before emitting to client
                  const guard = validateSingleToolCall(tc);
                  if (!guard.ok) {
                    allToolCallsValid = false;
                    console.warn(`[Guard] REJECTED streaming tool call "${tc.name}":`, guard.errors);
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
                    });
                    continue; // Skip — don't send malformed tool call to client
                  }
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

                // Only send text if all tool calls passed guard validation.
                // If any failed, suppress the text to prevent polluting client context.
                if (pendingText && allToolCallsValid && cleanedText) {
                  const contentDelta = getSnapshotDelta(cleanedText, lastFilteredSnapshot);
                  lastFilteredSnapshot = cleanedText;
                  if (contentDelta) {
                    if (!amplificationGuardTriggered) {
                      const projectedRatio =
                        (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
                      if (projectedRatio > 3 && emittedOutputBytes > 1000) {
                        amplificationGuardTriggered = true;
                        const ratio = Math.round(projectedRatio * 100) / 100;
                        console.error(
                          `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x ` +
                          `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                          `account=${resolvedEmail} model=${body.model}`
                        );
                        logStore.recordAmplificationEvent(
                          logId,
                          ratio,
                          lastRawContent || lastVStrRaw || ''
                        );
                      }
                    }
                    if (amplificationGuardTriggered) {
                      continue;
                    }
                    logStore.addProcessedOutput(logId, contentDelta);
                    emittedOutputBytes += contentDelta.length;
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ content: contentDelta })]
                    });
                  }
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
      const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
      if (process.env.DEBUG) {
        if (remainingText) logDebug('STREAMING FLUSH TEXT', remainingText.length > 500 ? remainingText.substring(0, 500) : remainingText);
        if (remainingToolCalls.length) logDebug('STREAMING FLUSH TOOL CALLS', remainingToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
        logDebug('STREAMING FINISH REASON', toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop');
      }
      if (remainingThinking) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ reasoning_content: remainingThinking })]
        });
      }
      // Flush remaining text via snapshot diffing — avoid double-emitting content
      // already streamed. Compare the final full filtered text against the last
      // snapshot to emit only genuinely new content.
      if (remainingText) {
        lastFullContent += remainingText;
      }
      const { cleanText: flushBase, thinking: flushThinking } = (contentFiltering && lastFullContent)
        ? filterContent(lastFullContent)
        : { cleanText: lastFullContent || '', thinking: '' };
      const flushFiltered = stripToolCallArtifacts(flushBase);
      const flushCleaned = cleanThinkTags(flushFiltered);

      if (flushThinking) {
        const thinkDelta = getSnapshotDelta(flushThinking, lastThinkingSnapshot);
        if (thinkDelta) {
          lastThinkingSnapshot = flushThinking;
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ reasoning_content: thinkDelta })]
          });
        }
      }
      if (flushCleaned) {
        const contentDelta = getSnapshotDelta(flushCleaned, lastFilteredSnapshot);
        if (contentDelta) {
          // Amplification guard on flush emission
          if (!amplificationGuardTriggered) {
            const projectedRatio =
              (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
            if (projectedRatio > 3 && emittedOutputBytes > 1000) {
              amplificationGuardTriggered = true;
              const ratio = Math.round(projectedRatio * 100) / 100;
              console.error(
                `[Chat][AMPLIFICATION GUARD] Triggered on flush! ratio=${ratio}x ` +
                `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                `account=${resolvedEmail} model=${body.model}`
              );
              logStore.recordAmplificationEvent(
                logId,
                ratio,
                lastRawContent || lastVStrRaw || ''
              );
            }
          }
          if (amplificationGuardTriggered) {
            lastFilteredSnapshot = flushCleaned;
          } else {
            lastFilteredSnapshot = flushCleaned;
            const ct = contentDelta.replace(/[\n\s]*$/, '');
            if (ct) {
              logStore.addProcessedOutput(logId, ct);
              emittedOutputBytes += ct.length;
              await writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [makeChoice({ content: ct })]
              });
            }
          }
        }
      }
      for (const tc of remainingToolCalls) {
        // Guard: validate tool call before emitting to client
        const guard = validateSingleToolCall(tc);
        if (!guard.ok) {
          console.warn(`[Guard] REJECTED streaming flush tool call "${tc.name}":`, guard.errors);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Guard rejected streaming flush tool call "${tc.name}": ${guard.errors.join(', ')}`);
          });
          continue;
        }
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

      // Log final amplification ratio for observability
      const finalRatio =
        rawInputBytes > 0 ? Math.round((emittedOutputBytes / rawInputBytes) * 100) / 100 : 0;
      if (finalRatio > 2) {
        console.warn(
          `[Chat] High amplification ratio: ${finalRatio}x ` +
          `(rawIn=${rawInputBytes}B, out=${emittedOutputBytes}B) account=${resolvedEmail}`
        );
        logStore.updateEntry(logId, (entry) => {
          entry.amplificationRatio = finalRatio;
        });
      }

      console.log(`[Chat] account=${resolvedEmail} chunks=${totalChunks} stream complete`);

      // Capture cleanup refs for deferred background cleanup.
      // DO NOT do anything else here — callback must return ASAP so Hono
      // flushes [DONE] and closes the HTTP response. Client disconnects immediately.
      const _cleanupReader = reader;
      const _cleanupInterval = heartbeatInterval;
      const _cleanupChatId = session.chatId;
      const _cleanupParentId = nextParentId;
      const _cleanupHeaders = sessionHeaders;
      const _cleanupEmail = resolvedEmail;

      // 200ms delay ensures the HTTP response is fully flushed and TCP FIN is sent
      // before any background work competes for event loop time.
      setTimeout(() => {
        clearInterval(_cleanupInterval);
        try { _cleanupReader.cancel(); } catch {}
        try { _cleanupReader.releaseLock(); } catch {}
        sessionPool.release(_cleanupChatId, _cleanupParentId, _cleanupHeaders, _cleanupEmail);
        // Persist raw vs processed output for debugging
        const entry = logStore.getRecent(1).find(e => e.id === logId);
        if (entry) logStore.persistRequest(entry);
      }, 200);

      } finally {
        clearInterval(heartbeatInterval);
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
