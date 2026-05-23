import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('JSON parser: tool call extracted from text', () => {
  const p = new StreamingToolParser();
  const r = p.feed('Hello {"name": "read_file", "arguments": {"path": "foo.txt"}} world');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, 'read_file');
  assert.strictEqual(r.toolCalls[0].arguments.path, 'foo.txt');
  assert.strictEqual(r.text, 'Hello  world');
});

test('JSON parser: strips markdown fences', () => {
  const p = new StreamingToolParser();
  const r = p.feed('Here:\n```json\n{"name": "read_file", "arguments": {"path": "x.txt"}}\n```\n');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].arguments.path, 'x.txt');
  assert.ok(r.text.includes('Here:'));
});

test('JSON parser: multiple tool calls', () => {
  const p = new StreamingToolParser();
  const r = p.feed('{"name": "a", "arguments": {}} {"name": "b", "arguments": {}}');
  assert.strictEqual(r.toolCalls.length, 2);
  assert.strictEqual(r.toolCalls[0].name, 'a');
  assert.strictEqual(r.toolCalls[1].name, 'b');
});

test('JSON parser: streaming split', () => {
  const p = new StreamingToolParser();
  const r1 = p.feed('{"name": "read", "arguments": {"path": "');
  const r2 = p.feed('x.txt"}}');
  const r3 = p.flush();
  const all = [...r1.toolCalls, ...r2.toolCalls, ...r3.toolCalls];
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].arguments.path, 'x.txt');
});

test('JSON parser: text before and after', () => {
  const p = new StreamingToolParser();
  const r = p.feed('start {"name": "x", "arguments": {}} end');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.ok(r.text.includes('start '));
  assert.ok(r.text.includes(' end'));
});

test('JSON parser: passThrough mode', () => {
  const p = new StreamingToolParser();
  p.passThrough = true;
  const r = p.feed('{"name": "x", "arguments": {}}');
  assert.strictEqual(r.text, '{"name": "x", "arguments": {}}');
  assert.strictEqual(r.toolCalls.length, 0);
});

test('JSON parser: nested JSON in arguments', () => {
  const p = new StreamingToolParser();
  const r = p.feed('{"name": "edit", "arguments": {"old": "foo", "config": {"nested": true}}}');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual((r.toolCalls[0].arguments as any).config.nested, true);
});

test('JSON parser: large tool call', () => {
  const p = new StreamingToolParser();
  const items = [];
  for (let i = 0; i < 500; i++) {
    items.push({ content: 'Item ' + i, status: 'pending' });
  }
  const largeJson = JSON.stringify({ name: 'todo_write', arguments: { todos: items } });
  const r = p.feed('Start ' + largeJson + ' End');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual((r.toolCalls[0].arguments as any).todos.length, 500);
  assert.ok(r.text.includes('Start '));
  assert.ok(r.text.includes(' End'));
});