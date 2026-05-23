import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('no leaking: split </tool_call> across 2 chunks does not leak tool_call>', () => {
  const parser = new StreamingToolParser();

  // Feed opening tag + JSON
  let r = parser.feed('<tool_call>{"name":"read","arguments":{"path":"x"}}');
  assert.strictEqual(r.toolCalls.length, 0);

  // Feed first half of closing tag (</tool)
  r = parser.feed('</tool');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.toolCalls.length, 0);

  // Feed second half (_call>)
  r = parser.feed('_call>');
  assert.strictEqual(r.text, '', 'Should NOT leak tool_call> as text');
  assert.strictEqual(r.toolCalls.length, 1, 'Should parse tool call when tag assembles');
  assert.strictEqual(r.toolCalls[0].name, 'read');
});

test('no leaking: </tool_call> split across 3 chunks', () => {
  const parser = new StreamingToolParser();

  let r = parser.feed('<tool_call>{"name":"x"}</to');
  assert.strictEqual(r.toolCalls.length, 0);

  r = parser.feed('ol_ca');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.toolCalls.length, 0);

  r = parser.feed('ll> done');
  assert.strictEqual(r.text, ' done', 'Text after assembled closing tag');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, 'x');
});

test('no leaking: </tool_call> split char by char', () => {
  const parser = new StreamingToolParser();

  parser.feed('<tool_call>{"name":"y","arguments":{}}');
  for (const ch of '</tool_call>') {
    parser.feed(ch);
  }

  assert.strictEqual(parser.getEmittedToolCallCount(), 1,
    'Tool call should be parsed after full closing tag assembled');
  assert.strictEqual(parser.feed(' trailing').text, ' trailing');
});

test('no leaking: bufferToolCalls with split closing tag', () => {
  const parser = new StreamingToolParser();
  parser.bufferToolCalls = true;

  // Text before, then opening tag + JSON
  let r = parser.feed('prefix <tool_call>{"name":"z","arguments":{}}');
  assert.strictEqual(r.text, '', 'prefix buffered');

  // Split closing tag
  r = parser.feed('</tool_');
  assert.strictEqual(r.text, '', 'partial closer should not leak');
  assert.strictEqual(r.toolCalls.length, 0);

  r = parser.feed('call>');
  assert.strictEqual(r.toolCalls.length, 1, 'Tool call parsed after assembly');
  assert.strictEqual(r.toolCalls[0].name, 'z');
  assert.strictEqual(r.text, 'prefix ', 'Buffered text returned with tool call (trailing space before tag)');
});

test('no leaking: orphan extraction only triggers on FULL </tool_call>', () => {
  const parser = new StreamingToolParser();

  // Simulate orphan case: JSON without <tool_call>, closing tag split
  parser.feed('{"name":"orphan","arguments":{"a":1}}');
  parser.feed('</too');
  parser.feed('l_call>');

  assert.strictEqual(parser.getEmittedToolCallCount(), 1,
    'Orphan tool call parsed when full </tool_call> arrives');
});

test('no leaking: partial closer in mix with other text does not leak', () => {
  const parser = new StreamingToolParser();

  let r = parser.feed('some text <tool_call>{"name":"clean"}');
  assert.strictEqual(r.text, 'some text ');
  assert.strictEqual(r.toolCalls.length, 0);

  r = parser.feed('</tool_call> and more text');
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, 'clean');
  assert.notStrictEqual(r.text, ' and more texttool_call>', 'No _call> suffix leak');
  assert.strictEqual(r.text, ' and more text');
});
