import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { reportRateLimitWall } from '../services/qwen.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls } from '../tools/xmlToolParser.ts';
import { type AmplificationGuardState, checkAmplificationGuard, getSnapshotDelta, parseQwenErrorPayload } from './chatHelpers.ts';
import { filterContentPipeline, processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { checkFinalAmplification, scheduleCleanup } from './cleanupHelpers.ts';
import { buildChunkEvent, buildUsage, makeChoice, writeEvent, writeReasoningEvent } from './writeHelpers.ts';

/** Shared TextDecoder — stateless, safe to reuse across streams */
export const sharedDecoder = new TextDecoder();

export interface StreamLoopResult {
  buffer: string;
  nextParentId: string | null;
  error?: string;
}

export async function runStreamLoop(
  c: { req: { raw?: { signal?: AbortSignal } } },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamState: StreamProcessingState,
  streamCtx: StreamProcessingCtx,
  ampState: AmplificationGuardState,
  bufferRef: { text: string },
): Promise<StreamLoopResult> {
  let streamDone = false;
  let nextParentId = streamState.nextParentId;

  while (true) {
    if (streamDone) break;
    if (c.req.raw?.signal?.aborted) {
      reader.cancel();
      break;
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let readResult: Awaited<ReturnType<typeof reader.read>>;
    let idleTimedOut = false;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<any>((_, reject) => {
          idleTimer = setTimeout(
            () => {
              idleTimedOut = true;
              reject(
                new Error(
                  `Upstream stream idle timeout — no data for ${Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 60000)) / 1000}s`,
                ),
              );
            },
            Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 60000)),
          );
        }),
      ]);
    } catch (timeoutErr) {
      if (idleTimer) clearTimeout(idleTimer);
      if (!idleTimedOut) await reader.cancel();
      return { buffer: bufferRef.text, nextParentId, error: (timeoutErr as Error).message };
    }
    if (idleTimer) clearTimeout(idleTimer);
    if (readResult.done) break;
    if (readResult.value) ampState.rawInputBytes += readResult.value.length;

    const rawDecoded = sharedDecoder.decode(readResult.value, { stream: true });
    bufferRef.text += rawDecoded;
    const lines = bufferRef.text.split('\n');
    bufferRef.text = lines.pop() || '';

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

        const result = await processStreamData(chunk, streamState, streamCtx);
        // Yield to the event loop after each event so Bun gets a socket flush
        // point per SSE event. Without this, one upstream-batched read with N
        // complete lines writes all N events back-to-back (0-4ms gaps) — the
        // client sees "everything at once" instead of a stream.
        await new Promise((r) => setTimeout(r, 0));
        if (result === 'break_stream') {
          streamDone = true;
          break;
        }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message, 'raw:', dataStr.slice(0, 200));
      }
    }
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, nextParentId };
}

export async function handlePostStreamCompletion(
  args: {
    streamWriter: any;
    completionId: string;
    model: string;
    streamState: StreamProcessingState;
    ampState: AmplificationGuardState;
    logId: string;
    resolvedEmail: string;
    emittedToolCallCount: number;
    buffer: string;
    enableContentFiltering: boolean;
    includeUsage: boolean;
  },
  cleanup: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    heartbeatInterval: any;
    chatId: string;
    sessionHeaders: any;
    email: string;
    sessionPool: { release: (chatId: string, parentId: string | null, headers: any, email: string) => void };
  },
): Promise<void> {
  const {
    streamWriter,
    completionId,
    model,
    streamState,
    ampState,
    logId,
    resolvedEmail,
    emittedToolCallCount,
    buffer,
    enableContentFiltering,
    includeUsage,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;

  try {
    // ── Flush partial content FIRST ──────────────────────────────────
    // If upstream aborted mid-stream (content filter, rate limit, etc.),
    // the chunks the user already saw must stay visible. Flush the
    // accumulated buffer before surfacing any error, so the client keeps
    // the partial answer instead of rolling back to a bare server error.
    if (streamState.pendingChunk) {
      streamState.lastFullContent += streamState.pendingChunk;
      streamState.pendingChunk = '';
    }

    // Count tool calls from the final assembled content
    const finalToolCalls = streamState.lastFullContent ? parseXmlToolCalls(streamState.lastFullContent).toolCalls.length : 0;
    const effectiveToolCallCount = Math.max(emittedToolCallCount, finalToolCalls);

    // Populate parsedToolCalls from full accumulated content (per-chunk extraction
    // never sees complete blocks since individual SSE deltas are too small).
    if (streamState.lastFullContent && effectiveToolCallCount > emittedToolCallCount) {
      const parsed = parseXmlToolCalls(streamState.lastFullContent).toolCalls;
      // Avoid double-counting: only add tool calls that weren't already emitted
      for (const tc of parsed.slice(emittedToolCallCount)) {
        logStore.updateEntry(logId, (entry) => {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        });
      }
    }

    const pipelineResult = filterContentPipeline(streamState.lastFullContent, enableContentFiltering);
    const flushCleaned = pipelineResult.cleanText;
    const flushThinking = pipelineResult.thinking;

    if (flushThinking) {
      const thinkDelta = getSnapshotDelta(flushThinking, streamState.lastThinkingSnapshot);
      if (thinkDelta) {
        streamState.lastThinkingSnapshot = flushThinking;
        await writeReasoningEvent(streamWriter, completionId, model, thinkDelta);
      }
    }
    if (flushCleaned) {
      const contentDelta = getSnapshotDelta(flushCleaned, streamState.lastFilteredSnapshot);
      if (contentDelta) {
        streamState.lastFilteredSnapshot = flushCleaned;
        if (
          checkAmplificationGuard(
            ampState,
            contentDelta.length,
            logId,
            resolvedEmail,
            model,
            streamState.lastRawContent,
            streamState.lastVStrRaw,
          )
        ) {
          // guard triggered — skip content emission
        } else {
          const ct = contentDelta.replace(/[\n\s]*$/, '');
          if (ct) {
            logStore.addProcessedOutput(logId, ct);
            ampState.emittedOutputBytes += ct.length;
            // Emit the end-of-stream delta in ≤256-char pieces with a flush
            // yield between each — prevents the whole remaining answer from
            // arriving as one burst right before finish_reason.
            for (let i = 0; i < ct.length; i += 256) {
              await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct.slice(i, i + 256) })]));
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
      }
    }

    // ── Upstream error: emit it AFTER the partial content ────────────
    const parsedError = parseQwenErrorPayload(buffer);
    const upstreamCode = parsedError?.code ?? streamState.upstreamCode;
    const upstreamWaitHours = parsedError?.waitHours ?? streamState.upstreamWaitHours;
    const upstreamError = parsedError || (streamState.upstreamError ? { message: streamState.upstreamError, status: 502 as const } : null);
    if (upstreamError) {
      // RateLimited wall inside an HTTP 200 stream: apply the same native
      // cooldown as an HTTP-level wall. Content may already be out — never
      // restart the stream here (it would duplicate output); finish with
      // the existing error mechanism instead.
      if (upstreamCode === 'RateLimited') {
        reportRateLimitWall(resolvedEmail, model, upstreamWaitHours);
        logStore.log('warn', 'chat', `[Chat] Mid-payload RateLimited on ${resolvedEmail} (${model}) — throttled, finishing stream`);
      }
      try {
        require('fs').writeFileSync('/tmp/qwen-error-buffer.json', buffer.slice(0, 10000));
      } catch {}
      const cleanErrorMessage = cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message;
      // Append the error as a final content chunk — the partial answer
      // stays visible, and the user sees why the stream stopped.
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: `\n\n[Error] ${cleanErrorMessage}` })]));
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_error';
      });
      logStore.finalizeRequest(logId);
      return;
    }

    const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);
    const finalFinishReason = effectiveToolCallCount > 0 ? 'tool_calls' : 'stop';

    await writeEvent(
      streamWriter,
      buildChunkEvent(completionId, model, [makeChoice({}, finalFinishReason)], includeUsage ? undefined : { usage }),
    );

    if (includeUsage) {
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [], { usage }));
    }
    await streamWriter.write('data: [DONE]\n\n');

    checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

    logStore.updateEntry(logId, (entry) => {
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = {
        finishReason: finalFinishReason || 'stop',
        toolCallCount: effectiveToolCallCount,
        contentPreview: (streamState.lastFullContent || '').substring(0, 100),
      };
    });

    logStore.finalizeRequest(logId);
  } catch (err) {
    console.error('[Chat] handlePostStreamCompletion error:', err);
    logStore.addError(logId, err instanceof Error ? err.message : String(err));
    // Preserve data that was set before flush (content, reasoning, etc.)
    logStore.updateEntry(logId, (entry) => {
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = entry.finalResponse || { finishReason: 'error', toolCallCount: 0, contentPreview: '' };
    });
    logStore.finalizeRequest(logId);
    // Always write [DONE] so the SSE stream terminates cleanly, even on error
    try {
      await streamWriter.write('data: [DONE]\n\n');
    } catch {
      /* stream may already be closed */
    }
  } finally {
    // Always release session to prevent pool exhaustion, even if writeEvent fails
    scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool);
  }
}
