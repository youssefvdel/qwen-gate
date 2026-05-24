import test from 'node:test';
import assert from 'node:assert';
import { filterContent, stripToolCallArtifacts } from './contentFilter.ts';

test('filterContent preserves instructional "I want to" prose', () => {
  const input = 'I want to help you fix this bug.\n\nThe issue is in auth.ts line 42 where the token check uses < instead of <=.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('fix this bug'), `cleanText should keep instructional content: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('auth.ts'), `cleanText should keep file references: "${result.cleanText}"`);
});

test('filterContent preserves "First, we need to" instructional content', () => {
  const input = 'First, we need to update the config file.\nThen, restart the server.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('update the config'), `Should keep instructional steps: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('restart the server'), `Should keep second step: "${result.cleanText}"`);
});

test('filterContent preserves "Here is the result" with actual content', () => {
  const input = 'Here is the result of the search:\n\n\nfile1.ts\nfile2.ts\n';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('file1.ts'), `Should keep result content: "${result.cleanText}"`);
});

test('filterContent preserves "Let me show you" with code', () => {
  const input = 'Let me show you the fix:\n\ntypescript\nif (token <= now) return false;\n';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('fix'), `Should keep "show you" instructional: "${result.cleanText}"`);
});

test('filterContent strips actual thinking content', () => {
  const input = 'I am evaluating the best approach for this problem.\nLet me consider the trade-offs carefully.';
  const result = filterContent(input);
  // This IS thinking — both lines are self-referential reasoning
  assert.ok(result.thinking.length > 0, 'Should capture thinking');
});

test('filterContent strips <think> tags and captures content', () => {
  const input = '<think>This is my internal reasoning</think>\n\nHere is the answer.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('Here is the answer'), `Should keep answer: "${result.cleanText}"`);
  assert.ok(result.thinking.includes('internal reasoning'), `Should capture thinking: "${result.thinking}"`);
  assert.ok(!result.cleanText.includes('<think>'), 'Should strip think tags from clean text');
});

test('filterContent preserves Step 1, Step 2 instructional patterns', () => {
  const input = 'Step 1: Open the terminal.\nStep 2: Run npm install.\nStep 3: Start the server.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('Step 1'), `Should keep Step 1: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('npm install'), `Should keep commands: "${result.cleanText}"`);
});

test('stripToolCallArtifacts removes JSON tool calls', () => {
  const input = 'Some text before\n{"name":"read_file","arguments":{"path":"test.ts"}}\nSome text after';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"name"'), `Should strip tool call JSON: "${result}"`);
  assert.ok(result.includes('Some text before'), 'Should keep text before');
  assert.ok(result.includes('Some text after'), 'Should keep text after');
});

test('stripToolCallArtifacts preserves normal JSON', () => {
  const input = 'Here is an example:\njson\n{"key": "value", "count": 42}\n';
  const result = stripToolCallArtifacts(input);
  // JSON without "name" field should be preserved
  assert.ok(result.includes('"key"'), `Should keep non-tool JSON: "${result}"`);
});
