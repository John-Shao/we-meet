import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { Supervisor } from '../src/supervisor.mjs';

const EXECUTION = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '44444444-4444-4444-8444-444444444444';
const OPERATION = '55555555-5555-4555-8555-555555555555';
const ATTEMPT = '66666666-6666-4666-8666-666666666666';
const CHECKPOINT = '77777777-7777-4777-8777-777777777777';
const REQUEST = '88888888-8888-4888-8888-888888888888';
const RECEIPT = '99999999-9999-4999-8999-999999999999';
const REQUEST_HASH = `sha256:${'a'.repeat(64)}`;
const CHECKPOINT_HASH = `sha256:${'b'.repeat(64)}`;
const RECEIPT_HASH = `sha256:${'c'.repeat(64)}`;

async function gatewayFixture() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        receipt: { refId: RECEIPT, hash: RECEIPT_HASH },
        usage: { source: 'provider', inputTokens: 23, outputTokens: 11, cachedInputTokens: 0 },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('production supervisor and real Pi child checkpoint one gateway capability without provider credentials', { timeout: 20000 }, async (t) => {
  const gateway = await gatewayFixture();
  t.after(() => gateway.close());
  const supervisor = new Supervisor({
    maxConcurrent: 1,
    runtimeVersion: 'runtime-provider-e2e',
    startTimeoutMs: 5000,
    runTimeoutMs: 15000,
    killGraceMs: 500,
  });
  t.after(() => supervisor.shutdown({ force: true }));
  const previousDashscopeKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = 'parent-provider-key-must-not-reach-child';
  t.after(() => {
    if (previousDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousDashscopeKey;
  });

  const result = await supervisor.start({
    runId: RUN,
    fence: '7',
    holderId: 'holder-provider-e2e',
    capabilities: {
      egress: {
        baseUrl: gateway.baseUrl,
        token: 'scoped-egress-token',
        generation: 1,
        expiresAt: Date.now() + 30_000,
      },
    },
    payload: {
      kind: 'advance_request',
      contractVersion: 'work-runtime-fragment-v1',
      executionId: EXECUTION,
      runId: RUN,
      taskId: TASK,
      orgId: 'org_provider_e2e',
      snapshotId: SNAPSHOT,
      runtimeVersion: 'runtime-provider-e2e',
      fence: '7',
      deadlineUnixMs: Date.now() + 60_000,
      mode: 'execute',
      checkpoint: { refId: CHECKPOINT, hash: CHECKPOINT_HASH },
      intent: {
        request: { refId: REQUEST, hash: REQUEST_HASH },
        requestHash: REQUEST_HASH,
        logicalKey: 'model:1',
      },
      permit: {
        operationId: OPERATION,
        dispatchAttemptId: ATTEMPT,
        requestHash: REQUEST_HASH,
      },
    },
  });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome.state, 'CHECKPOINTED');
  assert.deepEqual(result.outcome.receipt, { refId: RECEIPT, hash: RECEIPT_HASH });
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].url, '/runtime/v1/model/invoke');
  assert.equal(gateway.requests[0].headers.authorization, 'Bearer scoped-egress-token');
  assert.deepEqual(JSON.parse(gateway.requests[0].body), {
    executionId: EXECUTION,
    requestRef: { refId: REQUEST, hash: REQUEST_HASH },
    requestHash: REQUEST_HASH,
  });
  assert.equal(JSON.stringify(result).includes('parent-provider-key-must-not-reach-child'), false);
  assert.equal(JSON.stringify(gateway.requests).includes('parent-provider-key-must-not-reach-child'), false);
});
