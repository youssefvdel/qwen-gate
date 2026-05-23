import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('StreamingToolParser: large tool call (>100KB) not truncated while insideTool', () => {
  const parser = new StreamingToolParser();
  parser.bufferToolCalls = true;

  const TAG_START = String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62);
  const TAG_END = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);

  // Start tool call
  let r = parser.feed('Start ' + TAG_START);
  assert.strictEqual(r.text, '', 'Text before tag buffered');
  assert.strictEqual(r.toolCalls.length, 0);

  // Generate a large JSON payload (~120KB) to exceed MAX_BUFFER_SIZE (100KB)
  const largeItems = [];
  for (let i = 0; i < 2000; i++) {
    largeItems.push({
      content: 'Item ' + i + ' with some additional padding text to make it larger',
      status: 'pending',
      priority: i % 3 === 0 ? 'high' : 'low',
      description: 'This is a longer description field to increase the size of each item significantly'
    });
  }
  const largeJson = JSON.stringify({
    name: 'todo_write',
    arguments: { todos: largeItems }
  });

  // Verify our test data is actually > 100KB
  assert.ok(largeJson.length > 100_000, 'Test JSON should exceed 100KB, got: ' + largeJson.length);

  // Feed JSON in 2KB chunks (simulating streaming)
  const chunkSize = 2000;
  for (let i = 0; i < largeJson.length; i += chunkSize) {
    const chunk = largeJson.slice(i, i + chunkSize);
    r = parser.feed(chunk);
    assert.strictEqual(r.text, '', 'No text emitted while inside tool call (chunk ' + Math.floor(i/chunkSize) + ')');
    assert.strictEqual(r.toolCalls.length, 0, 'No tool call until closing tag');
  }

  // Close the tool call
  r = parser.feed(TAG_END + ' End');

  // Tool call should be successfully parsed (not truncated)
  assert.strictEqual(r.toolCalls.length, 1, 'Large tool call should parse successfully');
  assert.strictEqual(r.toolCalls[0].name, 'todo_write', 'Tool name correct');
  assert.strictEqual(r.toolCalls[0].arguments.todos.length, 2000, 'All 2000 items preserved');
  assert.strictEqual(r.text, 'Start  End', 'Buffered text returned with tool call');
});
