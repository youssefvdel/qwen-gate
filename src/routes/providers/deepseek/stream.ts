/*
 * File: providers/deepseek/stream.ts
 * DeepSeek custom SSE patch protocol parser.
 * Converts DeepSeek's JSON Patch-like protocol to OpenAI-compatible SSE chunks.
 *
 * DeepSeek protocol:
 *   data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"first chunk"}]}}}
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":" next chunk"}
 *   data: {"v":" another chunk"}
 *   data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":45},{"p":"quasi_status","v":"FINISHED"}]}
 *   data: {"p":"response/status","o":"SET","v":"FINISHED"}
 *   event: close
 *   data: {"click_behavior":"none","auto_resume":false}
 */

export interface DeepSeekStreamState {
  /** Accumulated visible content */
  content: string;
  /** Accumulated thinking/reasoning content */
  thinkingContent: string;
  /** Model type from ready event */
  modelType: string;
  /** Whether the stream has finished */
  isFinished: boolean;
  /** Token usage if provided */
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  /** Pending SSE event name from last "event:" line */
  _pendingEvent: string | null;
  /** Response message ID from ready event */
  _responseMessageId: number | null;
  /** Current fragment type (RESPONSE, THINKING, etc.) */
  _fragmentType: string;
  /**
   * Upstream error delivered as an SSE hint event (event: hint →
   * data: {"type":"error","content":"..."}). Set when DeepSeek rejects the
   * request inside a 200 stream (e.g. "Content is too long"). The pipeline
   * surfaces it as a real upstream error instead of streaming the text as
   * model content.
   */
  upstreamError?: { message: string; code?: string | number } | null;
  /**
   * When true (tool-call emulation mode), the parser still accumulates
   * content/thinking/usage into the state but emits NO output chunks — the
   * pipeline decides at stream end whether to emit a synthesized tool_calls
   * delta or flush the buffered content.
   */
  suppressOutput?: boolean;
}

export function createStreamState(): DeepSeekStreamState {
  return {
    content: '',
    thinkingContent: '',
    modelType: '',
    isFinished: false,
    usage: null,
    _pendingEvent: null,
    _responseMessageId: null,
    _fragmentType: 'RESPONSE',
    upstreamError: null,
  };
}

/**
 * Build an SSE chunk string for a content delta.
 */
function buildPatchChunk(content: string, isThinking: boolean, sessionId: string, model: string, ts: number): string {
  const delta: any = {};
  if (isThinking) delta.reasoning_content = content;
  else delta.content = content;
  return (
    'data: ' +
    JSON.stringify({
      id: sessionId,
      object: 'chat.completion.chunk',
      created: ts,
      model: model,
      choices: [{ index: 0, delta, finish_reason: null }],
    }) +
    '\n\n'
  );
}

/**
 * Apply a single JSON Patch-like operation to the stream state.
 * Returns accumulated SSE chunks for content changes.
 */
function applyPatch(
  state: DeepSeekStreamState,
  path: string,
  op: string,
  value: any,
  sessionId?: string,
  model?: string,
  ts?: number,
): string[] {
  var chunks: string[] = [];

  // BATCH operation: value is an array of sub-patches
  if (op === 'BATCH' && Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var sub = value[i];
      const subChunks = applyPatch(state, sub.p, sub.o || 'SET', sub.v, sessionId, model, ts);
      for (const c of subChunks) chunks.push(c);
    }
    return chunks;
  }

  // Helper to emit a chunk for content updates
  function emitContentChunk(content: string, isThinking: boolean): void {
    if (sessionId && model && ts !== undefined && content) {
      chunks.push(buildPatchChunk(content, isThinking, sessionId, model, ts));
    }
  }

  // APPEND / SET operations
  if (path === 'response/status' && op === 'SET') {
    if (value === 'FINISHED') {
      state.isFinished = true;
    }
    return chunks;
  }

  // New fragment appended via response/fragments — update type and accumulate initial content
  if (path === 'response/fragments' && op === 'APPEND' && Array.isArray(value)) {
    for (var fi = 0; fi < value.length; fi++) {
      var newFrag = value[fi];
      if (newFrag && newFrag.type) {
        state._fragmentType = String(newFrag.type);
        var fragContent = newFrag.content || '';
        var isThinking =
          state._fragmentType === 'THINKING' ||
          state._fragmentType === 'thinking' ||
          state._fragmentType === 'THINK' ||
          state._fragmentType === 'think';
        if (isThinking) {
          state.thinkingContent += fragContent;
        } else {
          state.content += fragContent;
        }
        emitContentChunk(fragContent, isThinking);
      }
    }
    return chunks;
  }

  // Content append/set on the last fragment — treat both APPEND and SET as appends for streaming
  if (path === 'response/fragments/-1/content') {
    if (typeof value === 'string') {
      var isThinking: boolean =
        state._fragmentType === 'THINKING' ||
        state._fragmentType === 'thinking' ||
        state._fragmentType === 'THINK' ||
        state._fragmentType === 'think';
      if (isThinking) {
        state.thinkingContent += value;
      } else {
        state.content += value;
      }
      emitContentChunk(value, isThinking);
    }
    return chunks;
  }

  if (path === 'response/fragments/-1/type' && op === 'SET') {
    state._fragmentType = String(value);
    return chunks;
  }

  // Handle accumulated_token_usage via batch sub-patches
  if (path === 'accumulated_token_usage') {
    if (typeof value === 'number') {
      if (!state.usage) {
        state.usage = { prompt_tokens: 0, completion_tokens: value, total_tokens: value };
      } else {
        state.usage.completion_tokens = value;
        state.usage.total_tokens = state.usage.prompt_tokens + value;
      }
    }
    return chunks;
  }

  if (path === 'quasi_status') {
    if (value === 'FINISHED') {
      state.isFinished = true;
    }
    return chunks;
  }

  return chunks;
}

/**
 * Parse a single SSE data line from DeepSeek and emit OpenAI-formatted chunks.
 * Call this for every "data:" line after stripping the "data: " prefix.
 * Returns accumulated delta chunks and whether the stream is done.
 */
export function parseDeepSeekData(
  dataStr: string,
  state: DeepSeekStreamState,
  model: string,
  sessionId: string,
  promptTokens?: number,
): { chunks: string[]; done: boolean } {
  var chunks: string[] = [];
  // Tool-call emulation mode (state.suppressOutput): keep accumulating
  // content/thinking/usage into the state but emit no SSE chunks — the
  // pipeline synthesizes the final output (tool_calls delta or flushed text).
  // Exception: reasoning (THINKING) fragments still stream through so clients
  // see live progress instead of dead air while the model composes its JSON.
  const push = (chunk: string): void => {
    if (!state.suppressOutput || chunk.includes('reasoning_content')) chunks.push(chunk);
  };

  // Skip non-JSON lines
  if (!dataStr.startsWith('{')) {
    // Check for event: lines processed by caller; here we only get data content
    return { chunks, done: state.isFinished };
  }

  try {
    var parsed = JSON.parse(dataStr);
  } catch {
    return { chunks, done: state.isFinished };
  }

  var ts = Math.floor(Date.now() / 1000);
  // Check for ready event data: { request_message_id, response_message_id, model_type }
  if (parsed.request_message_id !== undefined || parsed.model_type !== undefined) {
    state._responseMessageId = parsed.response_message_id || null;
    state.modelType = parsed.model_type || state.modelType;

    // Emit initial chunk with role: assistant
    push(
      'data: ' +
        JSON.stringify({
          id: sessionId,
          object: 'chat.completion.chunk',
          created: ts,
          model: model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        }) +
        '\n\n',
    );
    return { chunks, done: false };
  }

  // Handle full value push: {"v": {"response": {"fragments": [...]}}}
  if (parsed.v !== undefined && typeof parsed.v === 'object' && parsed.v !== null && !parsed.p) {
    var val = parsed.v;
    // Extract content from response fragments
    if (val.response && val.response.fragments && Array.isArray(val.response.fragments)) {
      for (var i = 0; i < val.response.fragments.length; i++) {
        var frag = val.response.fragments[i];
        var fragType = frag.type || 'RESPONSE';
        var fragContent = frag.content || '';

        if (fragType === 'THINKING' || fragType === 'thinking' || fragType === 'THINK' || fragType === 'think') {
          state.thinkingContent += fragContent;
          state._fragmentType = 'THINKING';
          // Emit reasoning_content for thinking fragments
          push(
            'data: ' +
              JSON.stringify({
                id: sessionId,
                object: 'chat.completion.chunk',
                created: ts,
                model: model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: fragContent },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n',
          );
        } else {
          state.content += fragContent;
          state._fragmentType = 'RESPONSE';
          push(
            'data: ' +
              JSON.stringify({
                id: sessionId,
                object: 'chat.completion.chunk',
                created: ts,
                model: model,
                choices: [
                  {
                    index: 0,
                    delta: { content: fragContent },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n',
          );
        }
      }
    }

    // Handle usage in full value
    if (val.response && val.response.accumulated_token_usage !== undefined) {
      var usageVal = val.response.accumulated_token_usage;
      if (!state.usage) {
        state.usage = { prompt_tokens: 0, completion_tokens: usageVal, total_tokens: usageVal };
      } else {
        state.usage.completion_tokens = usageVal;
        state.usage.total_tokens = state.usage.prompt_tokens + usageVal;
      }
    }

    return { chunks, done: false };
  }

  // Handle shorthand append: {"v": "string content"}
  if (parsed.v !== undefined && typeof parsed.v === 'string' && !parsed.p) {
    var contentDelta: string = parsed.v;

    if (state._fragmentType === 'THINKING') {
      state.thinkingContent += contentDelta;
      push(
        'data: ' +
          JSON.stringify({
            id: sessionId,
            object: 'chat.completion.chunk',
            created: ts,
            model: model,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: contentDelta },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
    } else {
      state.content += contentDelta;
      push(
        'data: ' +
          JSON.stringify({
            id: sessionId,
            object: 'chat.completion.chunk',
            created: ts,
            model: model,
            choices: [
              {
                index: 0,
                delta: { content: contentDelta },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
    }

    return { chunks, done: false };
  }

  // DeepSeek surfaces failures as SSE hint events: event: hint →
  // data: {"type":"error","content":"...","code":...}. Capture it as an
  // upstream error and do NOT stream the text as model content — the generic
  // inline-content branch below would otherwise emit it as the answer.
  if (parsed.type === 'error' && typeof parsed.content === 'string') {
    state.upstreamError = { message: parsed.content, code: parsed.code };
    state.isFinished = true;
    return { chunks, done: true };
  }

  // Handle inline content in data: {"content": "..."} (simpler format)
  if (parsed.content !== undefined && typeof parsed.content === 'string' && !parsed.v && !parsed.p) {
    state.content += parsed.content;
    push(
      'data: ' +
        JSON.stringify({
          id: sessionId,
          object: 'chat.completion.chunk',
          created: ts,
          model: model,
          choices: [
            {
              index: 0,
              delta: { content: parsed.content },
              finish_reason: null,
            },
          ],
        }) +
        '\n\n',
    );
    return { chunks, done: false };
  }

  // Handle patch operations: { p: path, o: op, v: value }
  if (parsed.p !== undefined) {
    const patchChunks = applyPatch(state, parsed.p, parsed.o || 'SET', parsed.v, sessionId, model, ts);
    for (const c of patchChunks) push(c);
    return { chunks, done: state.isFinished };
  }

  // Handle title event data: { content: "title" } from event: title
  // (title has no p/v fields, just content — but we check that content is a short string)
  if (parsed.click_behavior !== undefined) {
    // event: close — mark as finished
    state.isFinished = true;
    // Emit final finish (carrying usage so OpenAI clients can show context usage)
    const completionTokens = state.usage?.completion_tokens ?? Math.ceil((state.content.length + state.thinkingContent.length) / 4);
    const prompt = promptTokens ?? 0;
    push(
      'data: ' +
        JSON.stringify({
          id: sessionId,
          object: 'chat.completion.chunk',
          created: ts,
          model: model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: completionTokens,
            total_tokens: prompt + completionTokens,
          },
        }) +
        '\n\n',
    );
    return { chunks, done: true };
  }

  return { chunks, done: state.isFinished };
}
