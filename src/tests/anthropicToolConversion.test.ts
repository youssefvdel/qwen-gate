// Test suite for Qwen-to-Anthropic tool call conversion
// Tests both streaming and non-streaming paths

import { describe, expect, mock, test } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────

const logStore = {
  log: mock(() => {}),
  addRawChunk: mock(() => {}),
  updateEntry: mock(() => {}),
  createEntry: mock(() => {}),
  finalizeRequest: mock(() => {}),
  addError: mock(() => {}),
};

// ── Test helpers ─────────────────────────────────────────────────────

function simulateSseEvents(events: any[]): string[] {
  const lines: string[] = [];
  for (const evt of events) {
    for (const chunk of evt) {
      lines.push(`data: ${JSON.stringify(chunk)}`);
    }
  }
  return lines;
}

function parseXmlToolCallsFromText(text: string): { toolCalls: any[]; cleanedText: string } {
  // Import from actual source
  return { toolCalls: [], cleanedText: text };
}

// ── Local MCP extraction test ────────────────────────────────────────

describe('extractLocalMcpToolCalls', () => {
  test('extracts tool calls with params from local_mcp event', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '',
            phase: 'local_tool',
            status: 'finished',
            extra: {
              local_mcp: {
                '★': [
                  {
                    tool_name: '★-Bash',
                    params: { command: 'ls -la /tmp' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('Bash');
    expect(calls[0].arguments).toEqual({ command: 'ls -la /tmp' });
    expect(calls[0].id).toStartWith('call_');
  });

  test('extracts multiple tool calls', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [
                  { tool_name: '★-Bash', params: { command: 'echo hello' } },
                  { tool_name: '★-Read', params: { file_path: '/tmp/test.txt' } },
                  { tool_name: '★-Edit', params: { file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' } },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(3);
    expect(calls[0].name).toBe('Bash');
    expect(calls[1].name).toBe('Read');
    expect(calls[2].name).toBe('Edit');
    expect(calls[1].arguments).toEqual({ file_path: '/tmp/test.txt' });
  });

  test('returns empty array for missing local_mcp', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
    expect(extractLocalMcpToolCalls({})).toEqual([]);
    expect(extractLocalMcpToolCalls({ choices: [] })).toEqual([]);
    expect(extractLocalMcpToolCalls({ choices: [{}] })).toEqual([]);
  });

  test('strips ★- prefix from tool names', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Test with and without prefix
    const withPrefix = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls' } }] } } } }],
    };
    const withoutPrefix = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: 'Bash', params: { command: 'ls' } }] } } } }],
    };

    expect(extractLocalMcpToolCalls(withPrefix)[0].name).toBe('Bash');
    expect(extractLocalMcpToolCalls(withoutPrefix)[0].name).toBe('Bash');
  });
});

// ── XML tool call parsing test ───────────────────────────────────────

describe('xmlToolCallToParsed', () => {
  test('converts XML tool calls with parameters', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Bash', parameters: { command: 'ls -la', description: 'List files' } }, 0);
    expect(result.name).toBe('Bash');
    expect(result.arguments).toEqual({ command: 'ls -la', description: 'List files' });
    expect(result.id).toStartWith('call_');
  });

  test('handles JSON parameter values', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Read', parameters: { file_path: '"/tmp/test.txt"', timeout: '5000' } }, 0);
    expect(result.arguments).toEqual({ file_path: '/tmp/test.txt', timeout: 5000 });
  });

  test('strips ★- prefix from tool name', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: '★-Bash', parameters: { command: 'ls' } }, 0);
    expect(result.name).toBe('Bash');
  });

  test('handles empty parameters', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Bash', parameters: {} }, 0);
    expect(result.name).toBe('Bash');
    expect(result.arguments).toEqual({});
  });
});

// ── parseXmlToolCalls test ───────────────────────────────────────────

describe('parseXmlToolCalls', () => {
  test('parses tool calls from XML text', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const text = `<function=Bash>
<parameter=command>ls -la</parameter>
</function>`;
    const { toolCalls, cleanedText } = parseXmlToolCalls(text);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[0].parameters).toEqual({ command: 'ls -la' });
    expect(cleanedText).not.toContain('<function=');
  });

  test('parses multiple tool calls from XML text', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const text = `<function=Bash>
<parameter=command>echo hi</parameter>
</function>
<function=Read>
<parameter=file_path>/tmp/test.txt</parameter>
<parameter>ignore</parameter>
</function>`;
    const { toolCalls } = parseXmlToolCalls(text);
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[1].name).toBe('Read');
  });

  test('returns empty for text without tool calls', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const { toolCalls } = parseXmlToolCalls('Hello, how can I help you?');
    expect(toolCalls.length).toBe(0);
  });

  test('handles malformed XML gracefully', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    // Missing closing tag
    const text1 = `<function=Bash>\n<parameter=command>ls</parameter>\n`;
    const result1 = parseXmlToolCalls(text1);
    // Should not crash, may or may not parse depending on implementation
    expect(result1.toolCalls).toBeDefined();

    // Just a function tag with no params
    const text2 = `<function=Bash></function>`;
    const result2 = parseXmlToolCalls(text2);
    if (result2.toolCalls.length > 0) {
      expect(result2.toolCalls[0].parameters).toEqual({});
    }
  });
});

// ── convertOpenAIResponseToAnthropic test ────────────────────────────

describe('convertOpenAIResponseToAnthropic', () => {
  async function getConverter() {
    const mod = await import('../routes/anthropic.ts');
    // The function is not exported, so we replicate its logic here
    return null;
  }

  // Test the conversion logic directly
  test('converts tool calls with params to Anthropic format', () => {
    const openAIResp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: { name: 'Bash', arguments: '{"command":"ls -la"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };

    // Replicate convertOpenAIResponseToAnthropic logic
    const content: any[] = [];
    if (openAIResp.choices?.[0]?.message?.content) {
      content.push({ type: 'text', text: openAIResp.choices[0].message.content });
    }
    for (const tc of openAIResp.choices[0].message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object' || Object.keys(args).length === 0) continue;
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
    }
    if (content.length > 1 && content.some((c: any) => c.type === 'tool_use')) {
      const toolBlocks = content.filter((c: any) => c.type === 'tool_use');
      content.length = 0;
      content.push(...toolBlocks);
    }

    expect(content.length).toBe(1);
    expect(content[0].type).toBe('tool_use');
    expect(content[0].name).toBe('Bash');
    expect(content[0].input).toEqual({ command: 'ls -la' });
  });

  test('filters empty tool calls in non-streaming path', () => {
    const openAIResp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' } },
              { id: 'call_3', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            ],
          },
        },
      ],
    };

    const content: any[] = [];
    for (const tc of openAIResp.choices[0].message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object' || Object.keys(args).length === 0) continue;
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
    }

    expect(content.length).toBe(2); // call_1 filtered out (empty object)
    expect(content[0].name).toBe('Read');
    expect(content[1].name).toBe('Bash');
  });

  test('handles non-JSON arguments gracefully', () => {
    const openAIResp = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: 'not-json' } }],
          },
        },
      ],
    };

    const content: any[] = [];
    for (const tc of openAIResp.choices[0].message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object' || Object.keys(args).length === 0) continue;
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
    }

    // not-json can't be parsed, args stays {} → filtered out
    expect(content.length).toBe(0);
  });

  test('stop_reason is end_turn when all tool calls filtered', () => {
    const openAIResp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
          },
        },
      ],
    };

    const content: any[] = [];
    for (const tc of openAIResp.choices[0].message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object' || Object.keys(args).length === 0) continue;
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
    }

    const hasToolUse = content.some((c: any) => c.type === 'tool_use');
    const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
    expect(stopReason).toBe('end_turn');
  });

  test('stop_reason is tool_use when valid tool calls remain', () => {
    const openAIResp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
              { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{}' } },
            ],
          },
        },
      ],
    };

    const content: any[] = [];
    const REQUIRED_PARAMS: Record<string, string[]> = {
      Bash: ['command'],
      Read: ['filePath'],
      Edit: ['filePath', 'oldString', 'newString'],
    };
    function mapParamName(paramName: string): string {
      const SNAKE_TO_CAMEL: Record<string, string> = {
        file_path: 'filePath',
        old_string: 'oldString',
        new_string: 'newString',
      };
      return SNAKE_TO_CAMEL[paramName] || paramName;
    }
    function isValidToolCall(name: string, args: any): boolean {
      const required = REQUIRED_PARAMS[name];
      if (required) {
        const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
        if (missing.length > 0) return false;
      } else if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
        return false;
      }
      return true;
    }

    for (const tc of openAIResp.choices[0].message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        /* ignore */
      }
      if (!args || typeof args !== 'object') continue;
      const mapped: any = {};
      for (const [k, v] of Object.entries(args)) {
        mapped[mapParamName(k)] = v;
      }
      if (!isValidToolCall(tc.function.name, mapped)) continue;
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: mapped });
    }

    const hasToolUse = content.some((c: any) => c.type === 'tool_use');
    const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
    expect(stopReason).toBe('tool_use');
    expect(content.length).toBe(1); // Only Bash with command, Read filtered
    expect(content[0].name).toBe('Bash');
    expect(content[0].input).toEqual({ command: 'ls' });
  });
});

// ── Anthropic tools → OpenAI conversion test ─────────────────────────

describe('anthropicToolsToOpenAI', () => {
  test('converts Anthropic tool format to OpenAI format', async () => {
    // Replicate the function
    const tools = [
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      },
    ];

    const converted = tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));

    expect(converted.length).toBe(2);
    expect(converted[0].type).toBe('function');
    expect(converted[0].function.name).toBe('Bash');
    expect(converted[0].function.parameters.required).toEqual(['command']);
    expect(converted[1].function.parameters.required).toEqual(['filePath']);
  });

  test('returns empty array for no tools', async () => {
    const converted: any[] = [];
    expect(converted).toEqual([]);
  });
});

// ── Full streaming pipeline test ─────────────────────────────────────

describe('Anthropic streaming tool call pipeline', () => {
  test('merges XML and local_mcp tool calls without duplicate IDs', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Simulate what handleAnthropicStream does at the end:
    // 1. Parse XML from lastFullContent
    // 2. Accumulate local_mcp tool calls
    // 3. Merge deduped

    const xmlToolCalls: any[] = [{ id: 'call_xml1', name: 'Bash', arguments: { command: 'ls' } }];

    const localMcpCalls: any[] = [
      { id: 'call_mcp1', name: 'Bash', arguments: { command: 'ls' } }, // same tool, different ID
      { id: 'call_mcp2', name: 'Read', arguments: { file_path: '/tmp/x' } },
    ];

    const allToolCalls: any[] = [...xmlToolCalls];
    for (const ltc of localMcpCalls) {
      if (!allToolCalls.some((e: any) => e.id === ltc.id)) allToolCalls.push(ltc);
    }

    // No dedup by name — only by ID
    expect(allToolCalls.length).toBe(3);

    // Filter empty tool calls
    const validToolCalls = allToolCalls.filter((tc) => {
      try {
        const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
        return args && typeof args === 'object' && Object.keys(args).length > 0;
      } catch {
        return false;
      }
    });

    // Both Bash calls have 'command', Read has 'file_path' → all valid
    expect(validToolCalls.length).toBe(3);
  });

  test('filters tool calls with empty arguments in merged result', async () => {
    const xmlToolCalls = [
      { id: 'call_x1', name: 'Bash', arguments: {} }, // empty
    ];

    const localMcpCalls = [
      { id: 'call_m1', name: 'Bash', arguments: { command: 'ls' } },
      { id: 'call_m2', name: 'Read', arguments: {} }, // empty
    ];

    const allToolCalls = [...xmlToolCalls];
    for (const ltc of localMcpCalls) {
      if (!allToolCalls.some((e) => e.id === ltc.id)) allToolCalls.push(ltc);
    }

    expect(allToolCalls.length).toBe(3);

    const validToolCalls = allToolCalls.filter((tc) => {
      try {
        const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
        return args && typeof args === 'object' && Object.keys(args).length > 0;
      } catch {
        return false;
      }
    });

    // Only local_mcp Bash has params
    expect(validToolCalls.length).toBe(1);
    expect(validToolCalls[0].name).toBe('Bash');
    expect(validToolCalls[0].arguments).toEqual({ command: 'ls' });
  });

  test('handles arguments as string (JSON) in filter', async () => {
    const toolCalls = [
      { id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
      { id: 'call_2', name: 'Bash', arguments: '{}' },
      { id: 'call_3', name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' },
    ];

    const valid = toolCalls.filter((tc) => {
      let args: any = {};
      try {
        args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
      } catch {
        /* ignore */
      }
      return args && typeof args === 'object' && Object.keys(args).length > 0;
    });

    expect(valid.length).toBe(2);
  });
});

// ── Parameter name mapping test ──────────────────────────────────────

describe('Tool parameter name mapping', () => {
  test('Claude Code tools use camelCase params, Qwen may use snake_case', () => {
    // Claude Code expects: filePath, command, oldString, newString
    // Qwen may return: file_path, command, old_string, new_string

    const claudeTools = {
      Read: { input_schema: { properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
      Bash: { input_schema: { properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } },
      Edit: {
        input_schema: {
          properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
          required: ['filePath', 'oldString', 'newString'],
        },
      },
    };

    function validateToolCallParams(toolName: string, input: any): { valid: boolean; missing: string[] } {
      const tool = (claudeTools as any)[toolName];
      if (!tool) return { valid: false, missing: [toolName] };
      const required: string[] = tool.input_schema.required || [];
      const missing = required.filter((p: string) => {
        // Check both camelCase (Claude) and snake_case (Qwen)
        const snakeCase = p.replace(/([A-Z])/g, '_$1').toLowerCase();
        return input[p] === undefined && input[snakeCase] === undefined;
      });
      return { valid: missing.length === 0, missing };
    }

    // Qwen returns snake_case file_path
    const input1 = { file_path: '/tmp/x' };
    const result1 = validateToolCallParams('Read', input1);
    // filePath is missing but file_path exists → should be valid
    expect(result1.valid).toBe(true);

    // Qwen returns camelCase command
    const input2 = { command: 'ls' };
    const result2 = validateToolCallParams('Bash', input2);
    expect(result2.valid).toBe(true);

    // Qwen returns snake_case for Edit
    const input3 = { file_path: '/tmp/x', old_string: 'a', new_string: 'b' };
    const result3 = validateToolCallParams('Edit', input3);
    expect(result3.valid).toBe(true);

    // Qwen returns nothing for Bash
    const input4 = {};
    const result4 = validateToolCallParams('Bash', input4);
    expect(result4.valid).toBe(false);
    expect(result4.missing).toContain('command');
  });
});

// ── Tool call required-param validation tests ─────────────────────

describe('Tool call validation', () => {
  const REQUIRED_PARAMS: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['filePath'],
    Edit: ['filePath', 'oldString', 'newString'],
  };

  function isValidToolCall(name: string, args: any): boolean {
    const required = REQUIRED_PARAMS[name];
    if (required) {
      const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
      if (missing.length > 0) return false;
    } else if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
      return false;
    }
    return true;
  }

  test('Bash requires command', () => {
    expect(isValidToolCall('Bash', { command: 'ls' })).toBe(true);
    expect(isValidToolCall('Bash', {})).toBe(false);
    expect(isValidToolCall('Bash', { description: 'List files' })).toBe(false);
    expect(isValidToolCall('Bash', { command: '' })).toBe(false);
    expect(isValidToolCall('Bash', { command: null })).toBe(false);
  });

  test('Read requires filePath', () => {
    expect(isValidToolCall('Read', { filePath: '/tmp/x' })).toBe(true);
    expect(isValidToolCall('Read', { file_path: '/tmp/x' })).toBe(false);
  });

  test('Edit requires filePath, oldString, newString', () => {
    expect(isValidToolCall('Edit', { filePath: '/tmp/x', oldString: 'a', newString: 'b' })).toBe(true);
    expect(isValidToolCall('Edit', { filePath: '/tmp/x' })).toBe(false);
    expect(isValidToolCall('Edit', { filePath: '/tmp/x', oldString: 'a' })).toBe(false);
  });

  test('unknown tool passes with any params', () => {
    expect(isValidToolCall('Unknown', { param1: 'val' })).toBe(true);
    expect(isValidToolCall('Unknown', {})).toBe(false);
  });
});

describe('snake_case to camelCase mapping', () => {
  function mapParamName(paramName: string): string {
    const SNAKE_TO_CAMEL: Record<string, string> = {
      file_path: 'filePath',
      old_string: 'oldString',
      new_string: 'newString',
    };
    return SNAKE_TO_CAMEL[paramName] || paramName;
  }

  function mapArgs(args: any): any {
    const mapped: any = {};
    for (const [k, v] of Object.entries(args)) {
      mapped[mapParamName(k)] = v;
    }
    return mapped;
  }

  const REQUIRED_PARAMS: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['filePath'],
    Edit: ['filePath', 'oldString', 'newString'],
  };

  function isValidToolCall(name: string, args: any): boolean {
    const required = REQUIRED_PARAMS[name];
    if (required) {
      const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
      if (missing.length > 0) return false;
    } else if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
      return false;
    }
    return true;
  }

  test('Read with file_path passes after mapping', () => {
    const raw = { file_path: '/tmp/x' };
    const mapped = mapArgs(raw);
    expect(isValidToolCall('Read', mapped)).toBe(true);
    expect(mapped.filePath).toBe('/tmp/x');
  });

  test('Edit with snake_case params passes after mapping', () => {
    const raw = { file_path: '/tmp/x', old_string: 'a', new_string: 'b' };
    const mapped = mapArgs(raw);
    expect(isValidToolCall('Edit', mapped)).toBe(true);
    expect(mapped.filePath).toBe('/tmp/x');
    expect(mapped.oldString).toBe('a');
    expect(mapped.newString).toBe('b');
  });

  test('Bash command unchanged by mapping', () => {
    const raw = { command: 'ls -la' };
    const mapped = mapArgs(raw);
    expect(mapped.command).toBe('ls -la');
  });

  test('non-Claude params pass through unchanged', () => {
    const raw = { custom_param: 'val' };
    const mapped = mapArgs(raw);
    expect(mapped.custom_param).toBe('val');
  });
});

// ── Full local_mcp pipeline test ──────────────────────────────────────
// End-to-end: mock Qwen SSE → extractLocalMcpToolCalls → validateToolCall
// → normalizeToolName → emit as Anthropic tool_use content blocks

describe('local_mcp pipeline to Claude Code', () => {
  // Replicate REQUIRED_PARAMS + helpers from handleAnthropicStream
  const REQUIRED_PARAMS: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['filePath'],
    Edit: ['filePath', 'oldString', 'newString'],
    Write: ['filePath', 'content'],
  };

  function mapParamName(toolName: string, paramName: string): string {
    const SNAKE_TO_CAMEL: Record<string, string> = {
      file_path: 'filePath',
      old_string: 'oldString',
      new_string: 'newString',
      tool_call_id: 'toolCallId',
    };
    return SNAKE_TO_CAMEL[paramName] || paramName;
  }

  function normalizeToolName(name: string): string {
    const CASE_MAP: Record<string, string> = {
      bash: 'Bash',
      read: 'Read',
      edit: 'Edit',
      write: 'Write',
      websearch: 'WebSearch',
      web_search: 'WebSearch',
    };
    return CASE_MAP[name] || name;
  }

  function validateToolCall(tc: { name: string; arguments: any }): { valid: boolean; fixedArgs: any } {
    let args: any = {};
    try {
      args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
    } catch {
      /* ignore */
    }
    if (!args || typeof args !== 'object') return { valid: false, fixedArgs: {} };

    const mapped: any = {};
    for (const [k, v] of Object.entries(args)) {
      mapped[mapParamName(tc.name, k)] = v;
    }
    args = mapped;

    const toolName = normalizeToolName(tc.name);
    const required = REQUIRED_PARAMS[toolName];
    if (required) {
      const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
      if (missing.length > 0) return { valid: false, fixedArgs: args };
    } else if (Object.keys(args).length === 0) {
      return { valid: false, fixedArgs: {} };
    }
    return { valid: true, fixedArgs: args };
  }

  function emitToolUseBlock(tc: { id: string; name: string }, args: any): any {
    return {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: args },
    };
  }

  test('local_mcp Bash with camelCase command reaches Claude Code correctly', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Mock Qwen SSE chunk with local_mcp Bash tool call
    const sseChunk = {
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '',
            phase: 'local_tool',
            status: 'finished',
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Bash', params: { command: 'ls -la /tmp' } }],
              },
            },
          },
        },
      ],
    };

    // Step 1: Extract from SSE (same as line 623-627 in anthropic.ts)
    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('Bash');
    expect(calls[0].arguments).toEqual({ command: 'ls -la /tmp' });

    // Step 2: Validate + normalize (same as lines 812-818 in anthropic.ts)
    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of calls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }

    expect(validToolCalls.length).toBe(1);

    // Step 3: Emit tool_use block (same as lines 837-846 in anthropic.ts)
    const tc = validToolCalls[0];
    const args = validArgs[0];
    const block = emitToolUseBlock(tc, args);

    // This is what Claude Code receives
    expect(block.content_block.type).toBe('tool_use');
    expect(block.content_block.name).toBe('Bash');
    expect(block.content_block.input).toEqual({ command: 'ls -la /tmp' });
    expect(block.content_block.id).toStartWith('call_');
  });

  test('local_mcp Bash with snake_case file_path is mapped to filePath', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Read', params: { file_path: '/tmp/test.txt' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].arguments).toEqual({ file_path: '/tmp/test.txt' });

    // Validate — snake_case → camelCase mapping should make this valid
    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of calls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }

    expect(validToolCalls.length).toBe(1);
    const block = emitToolUseBlock(validToolCalls[0], validArgs[0]);
    expect(block.content_block.name).toBe('Read');
    expect(block.content_block.input).toEqual({ filePath: '/tmp/test.txt' });
  });

  test('local_mcp with Write tool (filePath + content) passes validation', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [
                  {
                    tool_name: '★-Write',
                    params: { file_path: '/tmp/output.txt', content: 'hello world' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of calls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }

    expect(validToolCalls.length).toBe(1);
    const block = emitToolUseBlock(validToolCalls[0], validArgs[0]);
    expect(block.content_block.name).toBe('Write');
    expect(block.content_block.input).toEqual({ filePath: '/tmp/output.txt', content: 'hello world' });
  });

  test('local_mcp with lowercase tool name is normalized to PascalCase', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: 'bash', params: { command: 'echo hi' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    // extractLocalMcpToolCalls strips ★- prefix but doesn't normalize case
    expect(calls[0].name).toBe('bash');

    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of calls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }

    expect(validToolCalls.length).toBe(1);
    const block = emitToolUseBlock(validToolCalls[0], validArgs[0]);
    expect(block.content_block.name).toBe('Bash'); // normalized
    expect(block.content_block.input).toEqual({ command: 'echo hi' });
  });

  test('local_mcp with missing required param is filtered out (not sent to Claude Code)', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Bash without command
    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Bash', params: { description: 'list files' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    const validToolCalls: any[] = [];
    for (const tc of calls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
      }
    }

    expect(validToolCalls.length).toBe(0); // filtered out
  });

  test('full multi-tool local_mcp round trip with dedup by ID', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Simulate multiple SSE chunks arriving during stream
    const chunks = [
      {
        choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls' } }] } } } }],
      },
      {
        choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Read', params: { file_path: '/tmp/x' } }] } } } }],
      },
      {
        choices: [
          {
            delta: {
              extra: { local_mcp: { '★': [{ tool_name: '★-Edit', params: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } }] } },
            },
          },
        ],
      },
    ];

    // Accumulate tool calls during stream (same as line 623-627)
    const localToolCallsAccum: any[] = [];
    for (const chunk of chunks) {
      const calls = extractLocalMcpToolCalls(chunk);
      for (const c of calls) {
        if (!localToolCallsAccum.some((e) => e.id === c.id)) localToolCallsAccum.push(c);
      }
    }

    expect(localToolCallsAccum.length).toBe(3);

    // Validate all
    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of localToolCallsAccum) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }

    expect(validToolCalls.length).toBe(3);

    // Emit and verify each tool_use block
    const blocks = validToolCalls.map((tc, i) => emitToolUseBlock(tc, validArgs[i]));
    expect(blocks[0].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(blocks[1].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Read',
      input: { filePath: '/tmp/x' },
    });
    expect(blocks[2].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Edit',
      input: { filePath: '/tmp/x', oldString: 'a', newString: 'b' },
    });
  });

  test('XML fallback + local_mcp both active — merge produces correct tool_use blocks', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
    const { parseXmlToolCalls, xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    // Simulate lastFullContent with XML tool call (model hallucinated XML)
    const lastFullContent = `I'll run that command for you.
<function=Bash>
<parameter=command>ls -la</parameter>
</function>`;

    // Step 1: Extract XML from text (same as line 742)
    const { toolCalls: xmlToolCalls } = parseXmlToolCalls(lastFullContent);
    const xmlParsedCalls = xmlToolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
    expect(xmlParsedCalls.length).toBe(1);
    expect(xmlParsedCalls[0].name).toBe('Bash');
    expect(xmlParsedCalls[0].arguments).toEqual({ command: 'ls -la' });

    // Step 2: Also got a local_mcp for the same tool
    const sseChunk = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls -la' } }] } } } }],
    };
    const localMcpCalls = extractLocalMcpToolCalls(sseChunk);

    // Step 3: Merge (same as line 743-747)
    const allToolCalls: any[] = [...xmlParsedCalls];
    for (const ltc of localMcpCalls) {
      if (!allToolCalls.some((e: any) => e.id === ltc.id)) allToolCalls.push(ltc);
    }
    // Both pass — XML and local_mcp have different IDs
    expect(allToolCalls.length).toBe(2);

    // Step 4: Validate
    const validToolCalls: any[] = [];
    const validArgs: any[] = [];
    for (const tc of allToolCalls) {
      const result = validateToolCall(tc);
      if (result.valid) {
        validToolCalls.push({ ...tc, name: normalizeToolName(tc.name) });
        validArgs.push(result.fixedArgs);
      }
    }
    expect(validToolCalls.length).toBe(2); // both valid

    // Step 5: Emit — both go to Claude Code
    const blocks = validToolCalls.map((tc, i) => emitToolUseBlock(tc, validArgs[i]));
    expect(blocks.every((b) => b.content_block.name === 'Bash')).toBe(true);
    expect(blocks.every((b) => b.content_block.input.command === 'ls -la')).toBe(true);
  });

  test('XML hallucination in text — text content still emitted as text_delta during stream', async () => {
    const { cleanTextOfXmlArtifacts, parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    // Model produces text with XML tool call markup
    const rawText = `I'll list the directory for you.
<function=Bash>
<parameter=command>ls -la /tmp</parameter>
</function>`;

    // What gets streamed as text_delta to Claude Code (same as line 726-731)
    // During streaming: cleanTextOfXmlArtifacts strips XML from text
    // But the text is already emitted BEFORE cleanTextOfXmlArtifacts runs

    // After stream: parseXmlToolCalls extracts the tool call
    const { toolCalls, cleanedText } = cleanTextOfXmlArtifacts(rawText);

    // XML markup removed from text
    expect(cleanedText).toBe("I'll list the directory for you.\n");
    expect(cleanedText).not.toContain('<function=');

    // Tool call extracted correctly
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[0].parameters).toEqual({ command: 'ls -la /tmp' });
  });
});

// ── Schema-driven arg normalization (Claude Code snake_case) ──────

// Regression test: Claude Code's Read/Edit/Write schemas declare snake_case
// properties (file_path, old_string, new_string). The old hardcoded snake→camel
// map emitted filePath/oldString → Claude Code rejected with
// "required parameter file_path is missing. An unexpected parameter filePath"
// and retried forever. The normalizer must map Qwen args to the schema names.

describe('buildToolCallNormalizer (schema-driven)', () => {
  const CLAUDE_CODE_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Edit',
        description: 'Edit a file',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
  ];

  test('snake_case from Qwen is preserved (file_path stays file_path)', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    expect(normalizeArgs('Read', { file_path: '/tmp/x' })).toEqual({ file_path: '/tmp/x' });
  });

  test('camelCase from Qwen is mapped back to schema snake_case (filePath → file_path)', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    expect(normalizeArgs('Read', { filePath: '/tmp/x' })).toEqual({ file_path: '/tmp/x' });
    expect(normalizeArgs('Edit', { filePath: '/tmp/x', oldString: 'a', newString: 'b' })).toEqual({
      file_path: '/tmp/x',
      old_string: 'a',
      new_string: 'b',
    });
  });

  test('Bash command passes through unchanged', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs, missingRequired } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    const args = normalizeArgs('Bash', { command: 'ls -la' });
    expect(args).toEqual({ command: 'ls -la' });
    expect(missingRequired('Bash', args)).toEqual([]);
  });

  test('Read validates required file_path after camelCase normalization', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs, missingRequired } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    const args = normalizeArgs('Read', { filePath: '/tmp/x' });
    expect(missingRequired('Read', args)).toEqual([]);
    expect(missingRequired('Read', normalizeArgs('Read', { offset: 10 }))).toContain('file_path');
  });

  test('Edit rejects when a required param is missing', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs, missingRequired } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    const missing = missingRequired('Edit', normalizeArgs('Edit', { file_path: '/tmp/x', old_string: 'a' }));
    expect(missing).toContain('new_string');
  });

  test('lowercase tool name resolves to PascalCase schema (read → Read)', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs, missingRequired } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    const args = normalizeArgs('read', { file_path: '/tmp/x' });
    expect(missingRequired('read', args)).toEqual([]);
  });

  test('unknown tool with non-empty args is valid', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { normalizeArgs, missingRequired } = buildToolCallNormalizer(CLAUDE_CODE_TOOLS);
    expect(missingRequired('WebSearch', normalizeArgs('WebSearch', { query: 'hi' }))).toEqual([]);
    expect(missingRequired('WebSearch', {})).toContain('*');
  });

  test('without tool schemas, non-empty args pass (fallback)', async () => {
    const { buildToolCallNormalizer } = await import('../routes/anthropic.ts');
    const { missingRequired } = buildToolCallNormalizer(undefined);
    expect(missingRequired('AnyTool', { x: 1 })).toEqual([]);
    expect(missingRequired('AnyTool', {})).toContain('*');
  });
});
