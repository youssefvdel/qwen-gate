import { test } from 'node:test';
import assert from 'node:assert';
import { executeToolCalls } from '../tools/executor.ts';
import { registry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';

test('executeToolCalls: parallel execution', async () => {
  let activeCount = 0;
  let maxParallel = 0;

  registry.register(
    'parallel_tool',
    'A tool that waits to test parallelism',
    { type: 'object', properties: {} },
    async () => {
      activeCount++;
      maxParallel = Math.max(maxParallel, activeCount);
      await new Promise(r => setTimeout(r, 100));
      activeCount--;
      return 'done';
    }
  );

  const toolCalls = [
    { id: '1', name: 'parallel_tool', arguments: {} },
    { id: '2', name: 'parallel_tool', arguments: {} },
    { id: '3', name: 'parallel_tool', arguments: {} },
  ];

  const context: ToolContext = {
    messages: [],
    turn: 0,
    model: 'test'
  };

  const results = await executeToolCalls(toolCalls, context);
  
  assert.strictEqual(results.length, 3);
  assert.ok(maxParallel > 1, `Max parallel should be > 1, got ${maxParallel}`);
  
  registry.unregister('parallel_tool');
});
