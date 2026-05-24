import { setTimeout } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL || 'http://localhost:26405';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const REQUESTS = parseInt(process.env.REQUESTS || '100', 10);
const ENDPOINT = process.env.ENDPOINT || '/health';

let completed = 0;
let errors = 0;
let latencies: number[] = [];

async function makeRequest(id: number): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${ENDPOINT}`, {
      method: ENDPOINT === '/v1/chat/completions' ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: ENDPOINT === '/v1/chat/completions' ? JSON.stringify({
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'load test' }],
        stream: false
      }) : undefined
    });
    const latency = Date.now() - start;
    latencies.push(latency);
    if (!res.ok) errors++;
  } catch (e) {
    errors++;
  } finally {
    completed++;
  }
}

async function runLoadTest(): Promise<void> {
  console.log(`Starting load test: ${REQUESTS} requests, ${CONCURRENCY} concurrent, endpoint: ${ENDPOINT}`);
  const startTime = Date.now();

  for (let i = 0; i < REQUESTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j < REQUESTS; j++) {
      batch.push(makeRequest(i + j));
    }
    await Promise.all(batch);
  }

  const totalTime = Date.now() - startTime;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
  const p99 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)];

  console.log('\n=== Load Test Results ===');
  console.log(`Total requests: ${REQUESTS}`);
  console.log(`Successful: ${REQUESTS - errors}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total time: ${totalTime}ms`);
  console.log(`Throughput: ${(REQUESTS / totalTime * 1000).toFixed(2)} req/s`);
  console.log(`Avg latency: ${avgLatency.toFixed(2)}ms`);
  console.log(`P95 latency: ${p95?.toFixed(2) || 'N/A'}ms`);
  console.log(`P99 latency: ${p99?.toFixed(2) || 'N/A'}ms`);
}

runLoadTest().catch(console.error);
