import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';
import { getIncrementalDelta } from '../routes/chat.ts';

/**
 * Integration test: simulates EXACTLY what happens in production.
 * 
 * Qwen sends CUMULATIVE content in delta.content (full text so far).
 * getIncrementalDelta extracts the new portion.
 * That delta is fed to StreamingToolParser with bufferToolCalls=true.
 * 
 * This test catches bugs that unit tests miss because they bypass
 * the delta extraction layer.
 */

undefined