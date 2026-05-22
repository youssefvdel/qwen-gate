import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('StreamingToolParser: basic tool call', () => {
  const parser = new StreamingToolParser();
  
  const result = parser.feed('Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>');
  assert.strictEqual(result.text, 'Hello! ');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 't1');
});

test('StreamingToolParser: multiple tool calls', () => {
  const parser = new StreamingToolParser();
  
  const result = parser.feed('<tool_call>{"name": "t2", "arguments": {}}</tool_call><tool_call>{"name": "t3", "arguments": {}}</tool_call>');
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 't2');
  assert.strictEqual(result.toolCalls[1].name, 't3');
});

test('StreamingToolParser: fragmented tool call', () => {
  const parser = new StreamingToolParser();
  
  assert.strictEqual(parser.feed('Text <tool_').text, 'Text ');
  assert.strictEqual(parser.feed('call>{"name": ').text, '');
  const final = parser.feed('"frag", "arguments": {}}</tool_call> trailing');
  
  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, 'frag');
  assert.strictEqual(final.text, ' trailing');
});

test('StreamingToolParser: flush partial content', () => {
  const parser = new StreamingToolParser();
  
  parser.feed('Unfinished tag <tool_');
  assert.strictEqual(parser.flush().text, '<tool_');

  const parser2 = new StreamingToolParser();
  parser2.feed('Broken tool <tool_call>{"name": "healable"');
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'healable');
  
  const parser3 = new StreamingToolParser();
  parser3.feed('Invalid <tool_call>NOT_JSON');
  const flushed2 = parser3.flush();
  assert.strictEqual(flushed2.text, '<tool_call>NOT_JSON</tool_call>');
});

test('StreamingToolParser: robust parsing of malformed JSON', () => {
  const parser = new StreamingToolParser();
  
  const res = parser.feed('<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test('StreamingToolParser: preserves tags in non-tool text', () => {
  const parser = new StreamingToolParser();
  
  const res1 = parser.feed('Fake: <tool_call> { "only_args": 1 } </tool_call> ');
  assert.ok(res1.text.includes('<tool_call>'), 'Should contain start tag');
  assert.ok(res1.text.includes('</tool_call>'), 'Should contain end tag');
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 'r');
});

test('StreamingToolParser: handles multiple tool calls in array format', () => {
  const parser = new StreamingToolParser();
  
  const chunk = `<tool_call>[
  {"name": "bash", "arguments": {"command": "ls", "description": "List files"}},
  {"name": "read", "arguments": {"path": "test.txt"}}
]</tool_call>`;
  
  const result = parser.feed(chunk);
  assert.strictEqual(result.toolCalls.length, 2, 'Should extract both tool calls');
  assert.strictEqual(result.toolCalls[0].name, 'bash');
  assert.strictEqual(result.toolCalls[1].name, 'read');
  assert.strictEqual(result.toolCalls[0].arguments.command, 'ls');
});
