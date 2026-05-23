import { StreamingToolParser } from './src/tools/parser.ts';
const p = new StreamingToolParser();
const r1 = p.feed('{"name": "read", "arguments": {"path": ');
console.log('after chunk1 - buffer:', p.buffer, '| toolCalls:', r1.toolCalls.length);
const r2 = p.feed('"x.txt"}}');
console.log('after chunk2 - buffer:', p.buffer, '| toolCalls:', r2.toolCalls.length);
const r3 = p.flush();
console.log('after flush - toolCalls:', r3.toolCalls.length, 'total:', [...r1.toolCalls, ...r2.toolCalls, ...r3.toolCalls].length);
