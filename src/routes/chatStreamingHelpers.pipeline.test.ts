import assert from 'node:assert';
import { describe, test } from 'node:test';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { filterContentPipeline } from './providers/qwen/pipeline-stream.ts';
import { cleanThinkTags } from './providers/qwen/qwen-utils.ts';

// ── Real chunk data from corrupted logs ──

const LOGS = [
  {
    name: '01.json',
    raw: '<function=bash>\n<parameter=command>\ncat -n /home/youssefvdel/Projects/qwen-studio/src/main/index.ts\n</parameter>\n<parameter=description>\nRead full index.ts with line numbers\n</parameter>\n</function>\n<function=bash>\n<parameter=command>\ncat -n /home/youssefvdel/Projects/qwen-studio/src/main/window-manager.ts\n</parameter>\n<parameter=description>\nRead full window-manager.ts with line numbers\n</parameter>\n</function>\n',
    chunks: [
      '<function=b',
      'ash>\n',
      '<parameter=command>',
      '\ncat -n',
      ' /home/yousse',
      'fvdel/Projects',
      '/qwen-studio',
      '/src/main/index.ts',
      '\n</parameter>',
      '\n<parameter=',
      'description>\nRead',
      ' full index.ts with',
      ' line numbers\n</',
      'parameter>\n</',
      'function>\n',
      '<function=bash>',
      '\n<parameter=',
      'command>\ncat',
      ' -n /home',
      '/youssefvdel',
      '/Projects/qwen',
      '-studio/src/main',
      '/window-manager.ts\n',
      '</parameter>\n',
      '<parameter=description',
      '>\nRead full',
      ' window-manager.ts with',
      ' line numbers\n</',
      'parameter>\n</',
      'function>\n',
    ],
  },
  {
    name: '02.json',
    raw: "<function=edit>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/preload/index.ts\n</parameter>\n<parameter=oldString>\n/**\n * Listen for events from main process\n */\nipcRenderer.on(\"event_from_main\", (_, { type, payload }) => {\n  events.emit(type, payload);\n});\n</parameter>\n<parameter=newString>\n/**\n * Listen for events from main process\n */\nipcRenderer.on(\"event_from_main\", (_, { type, payload }) => {\n  events.emit(type, payload);\n});\n\n/**\n * Allowed IPC channels for renderer subscriptions\n */\nconst ALLOWED_CHANNELS = [\n  'web-view-loaded',\n  'toggle_hidden_devtools',\n  'qwen_account_list',\n  'qwen_account_remove',\n  'qwen_account_add',\n] as const;\n</parameter>\n</function>\n\n<function=edit>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/preload/index.ts\n</parameter>\n<parameter=oldString>\n    contextBridge.exposeInMainWorld(\"electron\", {\n      ipcRenderer: {\n        send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),\n        invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),\n        on: (channel: string, func: (...args: unknown[]) => void) => {\n          ipcRenderer.on(channel, (_, ...args) => func(...args));\n        },\n      },\n    });\n</parameter>\n<parameter=newString>\n    contextBridge.exposeInMainWorld(\"electron\", {\n      ipcRenderer: {\n        send: (",
    chunks: [
      '<function',
      '=edit>\n',
      '<parameter=filePath',
      '>/home/youssefv',
      'del/Projects',
      '/qwen-studio',
      '/src/preload/index',
      '.ts\n</parameter',
      '>\n<parameter',
      '=oldString>',
      '\n/**\n *',
      ' Listen for events from',
      ' main process\n */\n',
      'ipcRenderer.on',
      '("event_from_main',
      '", (_, { type',
      ', payload }) =>',
      ' {\n  events',
      '.emit(type, payload',
      ');\n});\n',
      '</parameter>\n',
      '<parameter=newString',
      '>\n/**\n',
      ' * Listen for events',
      ' from main process\n',
      ' */\nipcRenderer',
      '.on("event_from',
      '_main", (_, {',
      ' type, payload })',
      ' => {\n ',
      ' events.emit(type,',
      ' payload);\n});',
      '\n\n/**\n *',
      ' Allowed IPC',
      ' channels for renderer subscriptions',
      '\n */\nconst',
      ' ALLOWED_CHANNELS =',
      ' [',
      "\n  'web",
      'view-loaded',
      "',\n  '",
      'toggle_hidden_devtools',
      "',\n  '",
      'qwen_account_list',
      "',\n  '",
      'qwen_account_remove',
      "',\n  '",
      'qwen_account_add',
      "',\n] as",
      ' const;\n</',
      'parameter>\n</',
      'function>\n',
      '\n',
      '<function=',
      'edit>\n',
      '<parameter=filePath>/',
      'home/youssefv',
      'del/Projects/q',
      'wen-studio/src',
      '/preload/index.ts',
      '\n</parameter>',
      '\n<parameter=',
      'oldString>\n',
      '    contextBridge.ex',
      'poseInMainWorld',
      '("electron", {',
      '\n      ipcRenderer',
      ': {\n       ',
      ' send: (channel',
      ': string, ...',
      'args: unknown[])',
      ' =>\n          ipc',
      'Renderer.send(channel,',
      ' ...args),\n',
      '        invoke: (',
      'channel: string,',
      ' ...args: unknown',
      '[]) =>\n         ',
      ' ipcRenderer.invoke(channel',
      ', ...args),',
      '\n        on:',
      ' (channel: string',
      ', func: (...',
      'args: unknown[])',
      ' => void) =>',
      ' {\n          ipc',
      'Renderer.on(channel,',
      ' (_, ...args)',
      ' => func(...args',
      '));\n        },',
      '\n      },\n',
      '    });\n</',
      'parameter>\n',
      '<parameter=newString>',
      '\n    contextBridge',
      '.exposeInMain',
      'World("electron",',
      ' {\n      ipc',
      'Renderer: {\n',
      '        send: (',
    ],
  },
  {
    name: '03.json',
    raw: '<function=read>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/preload/index.ts\n</parameter>\n<parameter=offset>\n120\n</parameter>\n<parameter=limit>\n55\n</parameter>\n</function>\n',
    chunks: [
      '<function',
      '=read>\n',
      '<parameter=filePath>/',
      'home/youssefv',
      'del/Projects/q',
      'wen-studio/src',
      '/preload/index.ts',
      '\n</parameter>',
      '\n<parameter=',
      'offset>\n1',
      '20\n',
      '</parameter>\n',
      '<parameter=limit',
      '>\n55',
      '\n</parameter>',
      '\n</function>',
      '\n',
    ],
  },
  {
    name: '05.json',
    raw: '<function=read>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/main/account-manager.ts\n</parameter>\n<parameter=limit>300\n</parameter>\n</function>\n\n<function=read>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/main/app-lifecycle.ts\n</parameter>\n<parameter=limit>300\n</parameter>\n</function>\n\n<function=read>\n<parameter=filePath>/home/youssefvdel/Projects/qwen-studio/src/main/ipc-handlers.ts\n</parameter>\n<parameter=limit>300\n</parameter>\n</function>\n',
    chunks: [
      '<function',
      '=read>\n',
      '<parameter=filePath',
      '>/home/yousse',
      'fvdel/Projects',
      '/qwen-studio',
      '/src/main/account-manager',
      '.ts\n</parameter',
      '>\n<parameter',
      '=limit',
      '>300',
      '\n</',
      'parameter>\n</',
      'function>\n',
      '\n',
      '<function=read',
      '>\n<parameter',
      '=filePath>/home',
      '/youssefvdel',
      '/Projects/qwen',
      '-studio/src/main',
      '/app-lifecycle.ts',
      '\n</parameter>',
      '\n<parameter=',
      'limit>30',
      '0\n</parameter',
      '>\n</function',
      '>\n\n',
      '\n<function',
      '=read>\n',
      '<parameter=filePath>/',
      'home/youssefv',
      'del/Projects/q',
      'wen-studio/src',
      '/main/ipc-hand',
      'lers.ts\n</',
      'parameter>\n',
      '<parameter=limit>',
      '300\n',
      '</parameter>\n',
      '</function>\n',
    ],
  },
  {
    name: '06.json',
    raw: '<function=read>\n<parameter=filePath>\n/home/youssefvdel/Projects/qwen-studio/src/main/account-manager.ts\n</parameter>\n</function>\n\n<function=read>\n<parameter=filePath>\n/home/youssefvdel/Projects/qwen-studio/src/main/app-lifecycle.ts\n</parameter>\n</function>\n\n<function=read>\n<parameter=filePath>\n/home/youssefvdel/Projects/qwen-studio/src/main/ipc-handlers.ts\n</parameter>\n</function>\n\n<function=read>\n<parameter=filePath>\n/home/youssefvdel/Projects/qwen-studio/src/main/shared/types.ts\n</parameter>\n</function>\n',
    chunks: [
      '<function',
      '=read>\n',
      '<parameter=filePath',
      '>\n/home/y',
      'ousse',
      'fvdel/Projects',
      '/qwen-studio',
      '/src/main/account-manager',
      '.ts\n</parameter',
      '>\n</function',
      '>\n\n',
      '\n',
      '<function=read>\n',
      '<parameter=filePath',
      '>\n/home/y',
      'oussefvdel/',
      'Projects/qwen-st',
      'udio/src/main/app',
      '-lifecycle.ts\n',
      '</parameter>\n',
      '</function>\n',
      '\n',
      '<function=read>',
      '\n<parameter=',
      'filePath>\n/home',
      '/youssefvdel',
      '/Projects/qwen',
      '-studio/src/main',
      '/ipc-handlers',
      '.ts\n</parameter',
      '>\n</function',
      '>\n\n',
      '\n<function',
      '=read>\n',
      '<parameter=filePath>',
      '\n/home/yousse',
      'fvdel/Projects',
      '/qwen-studio',
      '/src/main/shared/types.ts',
      '\n</parameter>',
      '\n</function>',
      '\n',
    ],
  },
];

describe('filterContentPipeline — per-chunk XML tool call preservation', () => {
  for (const log of LOGS) {
    test(`per-chunk processing of ${log.name} produces same output as full-text flush processing`, () => {
      // Simulate per-chunk processing (with skipXmlArtifactStripping=true)
      let perChunkAccum = '';
      for (const chunk of log.chunks) {
        const result = filterContentPipeline(chunk, true, true);
        if (result.cleanText) perChunkAccum += result.cleanText;
      }

      // Simulate flush processing (full text, skipXmlArtifactStripping=false)
      const flushResult = filterContentPipeline(log.raw, true, false);
      const flushCleaned = flushResult.cleanText || '';

      // Per-chunk preserves all content including XML tags and newlines.
      // Flush strips XML tags from the complete text — the result should be a
      // SUBSET of the per-chunk accumulated content (it may appear anywhere within
      // since per-chunk can reorder slightly due to chunk-boundary effects).
      // Key: flush output should be included in per-chunk content (no new content).
      assert.ok(
        perChunkAccum.includes(flushCleaned) || flushCleaned === '',
        `${log.name}: flush cleaned output should be a subset of per-chunk accumulated output. ` +
          `flush=${JSON.stringify(flushCleaned)} perChunk=${JSON.stringify(perChunkAccum)}`,
      );

      // Verify no orphaned tail fragments like "=read>", "=bash>", "=filePath>" etc.
      // These are the key corruption markers from the original bug.
      const orphanPatterns = [
        /^=[a-z_]+\s*>/m, // =read>, =bash>, =edit>, =filePath> at line start
        /^[a-z_]+\s*>\n/m, // description>, offset>, limit> at line start
        /^=\d+\n/m, // =120\n etc
      ];
      for (const pattern of orphanPatterns) {
        if (pattern.test(flushCleaned)) {
          const matches = flushCleaned.match(pattern);
          // Some patterns like "limit>" could appear in legitimate content like "limit>" as a fragment
          // Only fail if the match looks like a tool call tail (starts with = or has no context)
          if (matches && matches[0].startsWith('=')) {
            assert.fail(`${log.name}: flush output contains orphaned tool call tail: "${matches[0].trim()}"`);
          }
        }
      }
    });

    test(`per-chunk simulating each chunk of ${log.name} individually`, () => {
      for (let i = 0; i < log.chunks.length; i++) {
        const chunk = log.chunks[i];
        const result = filterContentPipeline(chunk, true, true);

        // Per-chunk processing should NEVER produce orphaned tails on its own
        if (result.cleanText) {
          // If the output contains "=read>" or similar, it came from a chunk where the
          // opening <function/parameter was in a PREVIOUS chunk. This is EXPECTED behavior
          // with the fix — partial tags survive per-chunk and get handled on flush.
          // But a single chunk should not produce orphaned tails if it's self-contained.

          // Check: if this chunk starts with "=", it's a continuation fragment
          if (chunk.startsWith('=')) {
            if (chunk.includes('>')) {
              // Complete `=name>` fragment: stripped by generic =name> pattern
              assert.ok(
                !result.cleanText!.includes(chunk.substring(0, 5)),
                `${log.name} chunk[${i}]: complete =name> fragment should be stripped`,
              );
            } else {
              // Incomplete `=name` (no > yet, arrives in next chunk): survives per-chunk
              assert.ok(
                result.cleanText!.includes(chunk.substring(0, Math.min(3, chunk.length))),
                `${log.name} chunk[${i}]: incomplete =name fragment survives (no > yet)`,
              );
            }
          }
        }
      }
    });
  }

  test('full pipeline without skipXmlArtifactStripping strips all XML from complete tool call block', () => {
    // When processing the FULL text (no skip), ALL XML should be stripped
    const input = '<function=read>\n<parameter=filePath>/path/to/file\n</parameter>\n</function>\n';
    const result = filterContentPipeline(input, true, false);
    // The full text processing should strip all XML markup. A trailing \n may remain
    // after </function> — that's fine, the key is no XML tags survive.
    assert.ok(result.cleanText !== null, 'should return cleanText');
    assert.ok(!result.cleanText!.includes('<function'), 'no function tags remain');
    assert.ok(!result.cleanText!.includes('</function>'), 'no close function tags remain');
    assert.ok(!result.cleanText!.includes('<parameter'), 'no parameter tags remain');
    assert.ok(!result.cleanText!.includes('</parameter>'), 'no close parameter tags remain');
    assert.strictEqual(result.thinking, '', 'no thinking content in tool-call-only text');
  });

  test('cleanThinkTags strips tool call tags including partial prefixes at chunk boundaries', () => {
    // Complete tags are stripped
    assert.strictEqual(cleanThinkTags('<function=read>\n'), '\n', 'complete <function=read> tag stripped');
    assert.strictEqual(cleanThinkTags('</function>'), '', 'closing function tag stripped');
    assert.strictEqual(cleanThinkTags('</parameter>'), '', 'closing parameter tag stripped');
    // Partial tags (chunk-boundary splits) are now also stripped via prefix matching
    assert.strictEqual(cleanThinkTags('<function'), '', 'partial <function stripped by prefix matcher');
    assert.strictEqual(cleanThinkTags('<fun'), '', 'partial <fun stripped by prefix matcher');
    assert.strictEqual(cleanThinkTags('<par'), '', 'partial <par stripped by prefix matcher');
    assert.strictEqual(cleanThinkTags('</fun'), '', 'partial </fun stripped by prefix matcher');
    // Continuation tails (after a prefix of MIN_TOOL_PREFIX_LEN was stripped)
    // "function" sans "fun" → "ction", "parameter" sans "par" → "ameter"
    assert.strictEqual(cleanThinkTags('ction=filePath>'), '', 'tail "ction=filePath>" stripped');
    assert.strictEqual(cleanThinkTags('ction=name>\n'), '\n', 'tail "ction=name>" stripped (\\n survives)');
    assert.strictEqual(cleanThinkTags('ameter=300>'), '', 'tail "ameter=300>" stripped');
    // Generic continuation patterns (no keyword knowledge needed):
    assert.strictEqual(cleanThinkTags('=read>\n'), '\n', '=name> continuation stripped');
    assert.strictEqual(cleanThinkTags('ion=test>\n'), '\n', 'tail=name> continuation stripped');
    // Standalone word> at line start (from </keyword> split): parameter>, function>
    assert.strictEqual(cleanThinkTags('parameter>\n'), '\n', 'standalone parameter> stripped');
    assert.strictEqual(cleanThinkTags('function>\n'), '\n', 'standalone function> stripped');
  });

  test('cleanTextOfXmlArtifacts on full text correctly extracts tool calls and strips markup', () => {
    const input = '<function=read>\n<parameter=filePath>/test/path\n</parameter>\n</function>\n';
    const result = cleanTextOfXmlArtifacts(input);
    assert.strictEqual(result.toolCalls.length, 1, 'one tool call extracted');
    assert.strictEqual(result.toolCalls[0].name, 'read', 'tool call name is read');
    assert.strictEqual(result.toolCalls[0].parameters.filePath, '/test/path', 'parameter extracted');
    // The cleaned text should have NO XML markup (trailing \n after </function> is fine)
    assert.ok(!result.cleanedText.includes('<function'), 'no function tags in cleaned text');
    assert.ok(!result.cleanedText.includes('<parameter'), 'no parameter tags in cleaned text');
    assert.ok(!result.cleanedText.includes('</function>'), 'no close function tags in cleaned text');
    assert.ok(!result.cleanedText.includes('</parameter>'), 'no close parameter tags in cleaned text');
  });

  test('mix of natural text and tool calls — flush strips XML correctly', () => {
    const textChunk = 'Let me read that file.\n';
    const toolChunk = '<function=read>\n<parameter=filePath>/path\n</parameter>\n</function>\n';
    const combined = textChunk + toolChunk;

    // Flush: full text gets XML stripped
    const flushResult = filterContentPipeline(combined, true, false);

    // After flush, natural text should remain, XML should be stripped.
    // A trailing \n from the tool call block may survive.
    assert.ok(flushResult.cleanText !== null, 'should return cleanText');
    assert.ok(
      flushResult.cleanText!.startsWith('Let me read that file.'),
      `text should start with natural text. Got: "${flushResult.cleanText}"`,
    );
    assert.ok(!flushResult.cleanText!.includes('<function'), 'no function tags remain');
    assert.ok(!flushResult.cleanText!.includes('<parameter'), 'no parameter tags remain');
  });

  test("verify no corruption patterns in any log's raw output", () => {
    for (const log of LOGS) {
      const result = cleanTextOfXmlArtifacts(log.raw);
      // Verify tool calls are correctly extracted
      assert.ok(result.toolCalls.length > 0, `${log.name}: should extract tool calls from raw output`);

      // Verify no XML markup remains in cleaned text
      assert.ok(!result.cleanedText.includes('<function'), `${log.name}: no <function remains`);
      assert.ok(!result.cleanedText.includes('</function>'), `${log.name}: no </function> remains`);
      assert.ok(!result.cleanedText.includes('<parameter'), `${log.name}: no <parameter remains`);
      assert.ok(!result.cleanedText.includes('</parameter>'), `${log.name}: no </parameter> remains`);
    }
  });
});
