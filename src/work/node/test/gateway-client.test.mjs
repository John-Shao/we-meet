import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createGatewayClient } from '../src/gateway-client.mjs';

const ORG = 'org_runtime';
const EXECUTION = '11111111-1111-4111-8111-111111111111';
const REQUEST_REF = '22222222-2222-4222-8222-222222222222';
const RECEIPT_REF = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'opaque-egress-token';
const HASH = `sha256:${'a'.repeat(64)}`;

const PAYLOAD = Object.freeze({
  executionId: EXECUTION,
  requestRef: { refId: REQUEST_REF, hash: HASH },
  requestHash: HASH,
});

async function startServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res, requests.length);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function client(server, overrides = {}) {
  return createGatewayClient({
    baseUrl: server.baseUrl,
    token: TOKEN,
    org: ORG,
    execution: EXECUTION,
    generation: 4,
    ...overrides,
  });
}

test('gateway client performs exactly one POST and returns the receipt', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      receipt: { refId: RECEIPT_REF, hash: HASH },
      usage: { source: 'provider', input: 11, output: 7, totalTokens: 18 },
    }));
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'success');
    assert.deepEqual(result.receipt, { refId: RECEIPT_REF, hash: HASH });
    assert.deepEqual(result.usage, {
      source: 'provider',
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 0,
    });
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/runtime/v1/model/invoke');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['x-work-org'], ORG);
    assert.equal(request.headers['x-work-execution'], EXECUTION);
    assert.equal(request.headers['x-work-generation'], '4');
    assert.deepEqual(JSON.parse(request.body), PAYLOAD);
  } finally {
    await server.close();
  }
});

test('gateway client treats an actionable 4xx as provable rejection without retrying', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'request_hash_mismatch' }));
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.code, 'request_hash_mismatch');
    assert.equal(result.status, 422);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('gateway client treats 429 as unknown and does not retry', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'rate_limited' }));
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.usage.inputTokens, null);
    assert.equal(server.requests.length, 1);
    await delay(50);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('gateway client treats 5xx as unknown and does not retry', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'draining' }));
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'server_error');
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('gateway client refuses redirects and never follows them', async () => {
  let targetHits = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/target') {
      targetHits += 1;
      res.writeHead(200);
      res.end('{}');
      return;
    }
    res.writeHead(307, { Location: '/target' });
    res.end();
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'redirect_refused');
    assert.equal(targetHits, 0);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('gateway client treats timeout as unknown', async () => {
  const server = await startServer(() => {
    // Never answer; the client timeout must classify the attempt as unknown.
  });
  try {
    const result = await client(server, { timeoutMs: 50 }).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'timeout');
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('gateway client treats a network failure as unknown with one attempt', async () => {
  let calls = 0;
  const failingFetch = async () => {
    calls += 1;
    throw new TypeError('network down');
  };
  const result = await createGatewayClient({
    baseUrl: 'http://127.0.0.1:9',
    token: TOKEN,
    org: ORG,
    execution: EXECUTION,
    generation: 1,
    fetchImpl: failingFetch,
  }).call(PAYLOAD);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.reason, 'network_error');
  assert.equal(calls, 1);
});

test('gateway client bounds the response body', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ receipt: { refId: RECEIPT_REF, hash: HASH }, pad: 'x'.repeat(512) }));
  });
  try {
    const result = await client(server, { maxResponseBytes: 64 }).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'response_too_large');
  } finally {
    await server.close();
  }
});

test('gateway client never invents a receipt from a 2xx body', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer: 'model text', usage: { source: 'provider' } }));
  });
  try {
    const result = await client(server).call(PAYLOAD);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.reason, 'response_invalid');
    assert.equal(result.receipt, undefined);
  } finally {
    await server.close();
  }
});

test('accepts the trusted gateway success envelope with derived metadata', async () => {
  const body = {
    outcome: 'succeeded',
    sent: true,
    requestHash: 'sha256:' + 'a'.repeat(64),
    gateState: 'consumed',
    receipt: {
      refId: '33333333-3333-4333-8333-333333333333',
      hash: 'sha256:' + 'b'.repeat(64),
      contentRef: 'content://work/org/receipt',
    },
    usage: { source: 'provider', inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
    answerRefId: '44444444-4444-4444-8444-444444444444',
  };
  const client = createGatewayClient({
    baseUrl: 'https://egress.test',
    token: 't',
    org: 'org_a',
    execution: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
  const result = await client.call({ executionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(result.outcome, 'success');
  assert.equal(result.receipt.refId, body.receipt.refId);
  assert.equal(result.usage.inputTokens, 1);
});

test('expiresAt caps the local capability lifetime', async () => {
  let clock = 1_000_000;
  const client = createGatewayClient({
    baseUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    org: ORG,
    execution: EXECUTION,
    generation: 1,
    expiresAt: clock + 50,
    now: () => clock,
  });
  clock += 50;
  const result = await client.call(PAYLOAD);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'capability_expired');
});
