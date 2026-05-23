import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

describe('StreamingToolParser - JSON-depth tracking', () => {
  it('handles </tool_call> literal inside string argument', () => {
    const parser = new StreamingToolParser();
    parser.bufferToolCalls = true;

    const input =
      'Here is the file:\n<tool_call>\n' +
      '{"name": "edit", "arguments": {"path": "parser.ts", "oldString": "<tool_call>\nfoo\n</tool_call>", "newString": "bar"}}\n' +
      '</tool_call>';

    const result = parser.feed(input);
    const flushed = parser.flush();

    assert.strictEqual(result.toolCalls.length, 1, 'should parse exactly one tool call');
    assert.strictEqual(result.toolCalls[0].name, 'edit');
    assert.strictEqual(result.toolCalls[0].arguments.path, 'parser.ts');
    assert.ok(
      (result.toolCalls[0].arguments.oldString as string).includes('</tool_call>'),
      'nested </tool_call> must survive inside string arg'
    );
    assert.strictEqual(result.text, 'Here is the file:\n', 'text before tag preserved, tag stripped');
    assert.strictEqual(result.thinking, '', 'no thinking');
    assert.strictEqual(flushed.toolCalls.length, 0);
    assert.strictEqual(flushed.text, '');
  });

  it('handles <tool_call> literal inside string argument', () => {
    const parser = new StreamingToolParser();
    parser.bufferToolCalls = true;

    const input =
      '<tool_call>\n' +
      '{"name": "write", "arguments": {"path": "x.ts", "content": "<tool_call>\\n{\\"name\\":\\"y\\"}\\n</tool_call>"}}\n' +
      '</tool_call>';

    const result = parser.feed(input);
    parser.flush();

    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, 'write');
    const content = result.toolCalls[0].arguments.content as string;
    assert.ok(content.includes('<tool_call>'), 'nested opener preserved');
    assert.ok(content.includes('</tool_call>'), 'nested closer preserved');
  });

  it('handles multiple tool calls back-to-back with nested tags', () => {
    const parser = new StreamingToolParser();
    parser.bufferToolCalls = true;

    const input =
      'Intro text\n' +
      '<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>\n' +
      'Middle\n' +
      '<tool_call>\n{"name": "edit", "arguments": {"path": "b.txt", "old": "</tool_call>"}}\n</tool_call>\n' +
      'Outro';

    const r1 = parser.feed(input);
    const r2 = parser.flush();

    const all = [...r1.toolCalls, ...r2.toolCalls];
    assert.strictEqual(all.length, 2, 'two tool calls parsed');
    assert.strictEqual(all[0].name, 'read');
    assert.strictEqual(all[1].name, 'edit');
    assert.strictEqual(all[1].arguments.old, '</tool_call>');
    assert.ok(r1.text.includes('Intro text'));
    assert.ok(r1.text.includes('Middle'));
    assert.ok(r1.text.includes('Outro'));
  });

  it('extracts <think> content and strips tags from text', () => {
    const parser = new StreamingToolParser();

    const input = 'Before <think>secret reasoning</think> After';
    const result = parser.feed(input);
    parser.flush();

    assert.strictEqual(result.thinking, 'secret reasoning');
    assert.strictEqual(result.text, 'Before  After');
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('extracts <thinking> (long form) same way', () => {
    const parser = new StreamingToolParser();
    const result = parser.feed('A<thinking>deep</thinking>B');
    parser.flush();
    assert.strictEqual(result.thinking, 'deep');
    assert.strictEqual(result.text, 'AB');
  });

  it('handles <think> with </tool_call> inside it (does not leak)', () => {
    const parser = new StreamingToolParser();
    const result = parser.feed('Text <think>model thought about </tool_call> here</think> more');
    parser.flush();
    assert.strictEqual(result.thinking, 'model thought about </tool_call> here');
    assert.strictEqual(result.text, 'Text  more');
    assert.ok(!result.text.includes('</tool_call>'), 'must not leak into text');
  });

  it('does not leak partial think tag fragments across chunks', () => {
    const parser = new StreamingToolParser();
    const r1 = parser.feed('hello <thi');
    assert.strictEqual(r1.text, 'hello ', 'partial tag held back');
    const r2 = parser.feed('nk>hidden</think> world');
    parser.flush();
    assert.strictEqual(r1.thinking, '');
    assert.strictEqual(r2.thinking, 'hidden');
    assert.ok(r2.text.includes(' world'));
    assert.ok(!r2.text.includes('<think>'));
  });

  it('handles tool call with escaped quotes containing tags', () => {
    const parser = new StreamingToolParser();
    parser.bufferToolCalls = true;

    const input =
      '<tool_call>\n' +
      '{"name": "edit", "arguments": {"old": "He said \\"</tool_call>\\" loudly"}}\n' +
      '</tool_call>';

    const r = parser.feed(input);
    parser.flush();

    assert.strictEqual(r.toolCalls.length, 1);
    assert.ok((r.toolCalls[0].arguments.old as string).includes('"</tool_call>"'));
  });

  it('handles streaming chunks split mid-JSON', () => {
    const parser = new StreamingToolParser();
    parser.bufferToolCalls = true;

    parser.feed('<tool_call>\n{"name": "read"');
    const r2 = parser.feed(', "arguments": {"path": "x.ts"}}\n</tool_call>');
    parser.flush();

    assert.strictEqual(r2.toolCalls.length, 1);
    assert.strictEqual(r2.toolCalls[0].name, 'read');
  });
});
