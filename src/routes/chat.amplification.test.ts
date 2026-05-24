import test from 'node:test';
import assert from 'node:assert';
import { commonPrefixLen, getNewContent } from './chat.ts';

test('commonPrefixLen detects cumulative chunks', () => {
  const prev = 'Hello world';
  const curr = 'Hello world, this is new';
  const len = commonPrefixLen(prev, curr);
  assert.strictEqual(len, prev.length);
});

test('getNewContent extracts only delta from cumulative', () => {
  const full = 'Hello world, this is new';
  const prev = 'Hello world';
  const delta = getNewContent(full, prev);
  assert.strictEqual(delta, ', this is new');
});

test('snapshot diffing breaks amplification loop', () => {
  // Real scenario: filter reclassifies prefix → one re-emission happens
  // but NEXT chunk finds common prefix → only delta emitted (no loop)

  // Chunk 1: filter keeps "I am analyzing the code"
  const snapshot1 = 'I am analyzing the code';
  // Emit all (first chunk)

  // Chunk 2: filter reclassifies → prefix changes
  const snapshot2 = 'the code and here is result';
  const delta2 = getNewContent(snapshot2, snapshot1);
  // Zero common prefix → full re-emission (expected, one-time)
  assert.strictEqual(delta2, snapshot2);

  // Chunk 3: more content appended, filter stable
  const snapshot3 = 'the code and here is result, plus more stuff';
  const delta3 = getNewContent(snapshot3, snapshot2);
  // Common prefix = snapshot2 length → only new part emitted
  assert.strictEqual(delta3, ', plus more stuff');

  // Key: no loop. After one re-emission, stable prefix → only deltas.
});

test('getNewContent handles zero common prefix', () => {
  const prev = 'completely different';
  const curr = 'new content here';
  const delta = getNewContent(curr, prev);
  assert.strictEqual(delta, curr);
});

test('getNewContent handles exact duplicate (retry)', () => {
  const prev = 'same content';
  const curr = 'same content';
  const delta = getNewContent(curr, prev);
  assert.strictEqual(delta, '');
});

test('getNewContent handles empty inputs', () => {
  assert.strictEqual(getNewContent('', ''), '');
  assert.strictEqual(getNewContent('', 'prev'), '');
  assert.strictEqual(getNewContent('new', ''), 'new');
});

test('commonPrefixLen handles empty strings', () => {
  assert.strictEqual(commonPrefixLen('', ''), 0);
  assert.strictEqual(commonPrefixLen('abc', ''), 0);
  assert.strictEqual(commonPrefixLen('', 'abc'), 0);
});

test('commonPrefixLen handles partial overlap', () => {
  assert.strictEqual(commonPrefixLen('abcdef', 'abcxyz'), 3);
  assert.strictEqual(commonPrefixLen('abc', 'xyz'), 0);
  assert.strictEqual(commonPrefixLen('abc', 'abcdef'), 3);
});
