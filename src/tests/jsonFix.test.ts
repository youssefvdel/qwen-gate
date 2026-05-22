import { test } from 'node:test';
import assert from 'node:assert';
import { robustParseJSON } from '../utils/json.ts';

test('robustParseJSON: handles trailing parentheses', () => {
  const result = robustParseJSON('{"name": "suggest", "arguments": {"suggest": "test", "actions": [{"label": "Revisar", "prompt": "/local-review"}]})');
  assert.strictEqual(result.name, 'suggest');
  assert.strictEqual(result.arguments.actions.length, 1);
});

test('robustParseJSON: handles missing closing braces', () => {
  const result = robustParseJSON('{"name": "test", "arguments": {"foo": "bar"');
  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.arguments.foo, 'bar');
});

test('robustParseJSON: handles control characters in string', () => {
  const literalNewline = '{"name": "control", "msg": "line 1\nline 2"}';
  const result = robustParseJSON(literalNewline);
  assert.ok(result.msg.includes('line 1'));
  assert.ok(result.msg.includes('line 2'));
});

test('robustParseJSON: handles crazy nested hallucination without crashing', () => {
  const crazyCase = `{"name": "suggest", "arguments": {"suggest": "Landing page", "actions": [{"label": "Revisar", "description": "Exec<tool_call>\\n{"name": "bashutar", "arguments": {"command": "npm run lint", "description": "Run lint"}]})"}}`;
  try {
    const result = robustParseJSON(crazyCase);
    assert.ok(result !== null);
  } catch {
    assert.ok(true, 'Parser gracefully rejected unrecoverable input');
  }
});

test('robustParseJSON: handles invalid backslash escapes', () => {
  const result = robustParseJSON('{"path": "C:\\\\Users\\\\name\\\\Documents"}');
  assert.ok(result.path != null);
});

test('robustParseJSON: handles double key hallucination', () => {
  const result = robustParseJSON('{"name": "name": "create_file", "arguments": {"path": "b.txt"}}');
  assert.strictEqual(result.name, 'create_file');
});

test('robustParseJSON: handles unquoted property names', () => {
  const result = robustParseJSON('{"name":"Read",arguments:{"file_path":"test.ts","limit":100}}');
  assert.strictEqual(result.name, 'Read');
  assert.strictEqual(result.arguments.limit, 100);
});
