import { test } from 'node:test';
import assert from 'node:assert';
import { getIncrementalDelta } from '../routes/chat.ts';

test('getIncrementalDelta: handles strictly cumulative stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = 'const x = 1;\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = 'const x = 1;\nconst y = 2;\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: handles strictly incremental stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = '\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = '\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: does not suffer from false-positive repetitive word overlap bugs', () => {
  // Previously, if oldStr ended in a common keyword and newStr started/contained the same keyword,
  // it would incorrectly match them and strip them. Let's verify this is fixed.
  let accumulated = 'import { useState } from \'react\';\nimport {';
  let nextChunk = ' Button } from \'@/components/ui/button\';';
  
  let res = getIncrementalDelta(accumulated, nextChunk);
  // It should treat the next chunk as strictly incremental and return it unchanged.
  assert.strictEqual(res.delta, ' Button } from \'@/components/ui/button\';');
  assert.strictEqual(res.matchedContent, 'import { useState } from \'react\';\nimport { Button } from \'@/components/ui/button\';');
});
