import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';

import {
  CONTRACT_VERSION,
  MAX_BODY_BYTES,
  ROUTE,
  createAdvanceServer,
} from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { createFakeAuthz } from '../test-support/fake-authz.mjs';
import { recordingSpawn, waitFor } from '../test-support/helpers.mjs';
import { createTLSFixture } from '../test-support/tls.mjs';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const REF_ID = '77777777-7777-4777-8777-777777777777';
const HASH = `sha256:${'a'.repeat(64)}`;

let pki;
let authz;

before(async () => {
  pki = await createTLSFixture();
  authz = await createFakeAuthz(pki);
});

after(async () => {
  await authz.close();
  await pki.cleanup();
});

function baseFragment(overrides = {}) {
  return {
    kind: 'advance_request',
    contractVersion: CONTRACT_VERSION,
    executionId: EXECUTION_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    orgId: 'org_transport',
    snapshotId: SNAPSHOT_ID,
    runtimeVersion: 'runtime-v1',
    fence: '7',
    deadlineUnixMs: Date.now() + 60_000,
    mode: 'plan',
    checkpoint: null,
    intent: null,
    permit: null,
    ...overrides,
  };
}

function executeFragment(overrides = {}) {
  return baseFragment({
    mode: 'execute',
    checkpoint: { refId: REF_ID, hash: HASH },
    intent: {
      request: { refId: REF_ID, hash: HASH },
      requestHash: HASH,
      logicalKey: 'model:1',
    },
    permit: { operationId: OPERATION_ID, dispatchAttemptId: ATTEMPT_ID, requestHash: HASH },
    ...overrides,
  });
}

async function startServer(controller, overrides = {}) {
  const supervisor = new Supervisor({
    maxConcurrent: 2,
    runtimeVersion: 'runtime-v1',
    startTimeoutMs: 3000,
    runTimeoutMs: 3000,
    killGraceMs: 150,
    spawn: controller.spawn,
    ...overrides,
  });
  const server = createAdvanceServer({
    supervisor,
    holderId: 'holder-test',
    cert: pki.cert,
    key: pki.key,
    ca: pki.ca,
    authz: authz.config,
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  return { supervisor, server, port: server.address().port };
}

async function stopServer({ supervisor, server }) {
  await supervisor.shutdown({ force: true });
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function send(port, {
  body = '',
  method = 'POST',
  path = ROUTE,
  cert = pki.clientCert,
  key = pki.clientKey,
  chunked = false,
} = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = { 'content-type': 'application/json' };
  if (!chunked) headers['content-length'] = String(payload.length);
  const options = {
    host: '127.0.0.1',
    port,
    path,
    method,
    ca: pki.ca,
    servername: 'localhost',
    headers,
    ...(cert === undefined || cert === null ? {} : { cert }),
    ...(key === undefined || key === null ? {} : { key }),
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('client_timeout')));
    req.end(payload);
  });
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(JSON.parse(response.body), { code });
}

test('a missing client certificate is rejected at TLS', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    await assert.rejects(
      send(running.port, { body: JSON.stringify(baseFragment()), cert: null, key: null }),
      (error) => {
        assert.ok(error instanceof Error);
        return true;
      },
    );
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('a valid client and fragment reach the child and return advance_result', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-runtime-server-'));
  const payloadFile = join(dir, 'payload.json');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const controller = recordingSpawn({
    behavior: 'ok',
    env: { WORK_STUB_PAYLOAD_FILE: payloadFile },
  });
  const running = await startServer(controller);
  try {
    const fragment = executeFragment();
    const response = await send(running.port, { body: JSON.stringify(fragment) });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.kind, 'advance_result');
    assert.equal(result.contractVersion, CONTRACT_VERSION);
    assert.equal(result.executionId, EXECUTION_ID);
    assert.equal(result.state, 'WAITING_RECONCILE');
    assert.equal(result.reason, 'provider_unknown');
    assert.equal(result.operationId, OPERATION_ID);
    assert.deepEqual(result.checkpoint, fragment.checkpoint);

    assert.equal(controller.records.length, 1);
    assert.equal(controller.records[0].exited, true);
    assert.deepEqual(JSON.parse(await readFile(payloadFile, 'utf8')), fragment);
  } finally {
    await stopServer(running);
  }
});

test('a valid plan fragment returns a schema-valid advance_result', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, { body: JSON.stringify(baseFragment()) });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.kind, 'advance_result');
    assert.equal(result.executionId, EXECUTION_ID);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.errorCode, 'runtime_fault');
    assert.equal(Object.hasOwn(result, 'operationId'), false);
    assert.equal(controller.records.length, 1);
  } finally {
    await stopServer(running);
  }
});

test('a child outcome round-trips as the signed advance_result body', { timeout: 15000 }, async () => {
  const marker = 'TASK_BODY_MARKER_5e1';
  const outcome = {
    state: 'CHECKPOINTED',
    checkpoint: { refId: REF_ID, hash: HASH },
    receipt: { refId: ATTEMPT_ID, hash: `sha256:${'b'.repeat(64)}` },
  };
  const controller = recordingSpawn({
    behavior: 'outcome',
    env: {
      WORK_STUB_RESULT_FRAME: JSON.stringify({
        v: 1, type: 'result', status: 'completed', outcome,
      }),
    },
  });
  const running = await startServer(controller);
  try {
    const fragment = executeFragment({ orgId: marker });
    const response = await send(running.port, { body: JSON.stringify(fragment) });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.deepEqual(result, {
      kind: 'advance_result',
      contractVersion: CONTRACT_VERSION,
      executionId: EXECUTION_ID,
      state: 'CHECKPOINTED',
      checkpoint: outcome.checkpoint,
      receipt: outcome.receipt,
    });
    assert.equal(response.body.includes(marker), false);
    assert.equal(response.body.includes('usage'), false);
    assert.equal(controller.records[0].exited, true);
  } finally {
    await stopServer(running);
  }
});

test('a signed FAILED outcome replaces the conservative plan mapping', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({
    behavior: 'outcome',
    env: {
      WORK_STUB_RESULT_FRAME: JSON.stringify({
        v: 1,
        type: 'result',
        status: 'failed',
        outcome: { state: 'FAILED', checkpoint: null, reason: 'invalid_context' },
      }),
    },
  });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, { body: JSON.stringify(baseFragment()) });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.reason, 'invalid_context');
    assert.equal(result.checkpoint, null);
    assert.equal(Object.hasOwn(result, 'errorCode'), false);
  } finally {
    await stopServer(running);
  }
});

test('a malformed outcome is a protocol_violation, never a guessed result', { timeout: 15000 }, async () => {
  const marker = 'TASK_BODY_MARKER_5e1';
  const controller = recordingSpawn({
    behavior: 'outcome',
    env: {
      WORK_STUB_RESULT_FRAME: JSON.stringify({
        v: 1,
        type: 'result',
        status: 'completed',
        outcome: {
          state: 'CHECKPOINTED',
          checkpoint: { refId: REF_ID, hash: HASH },
          receipt: { refId: ATTEMPT_ID, hash: `sha256:${'b'.repeat(64)}` },
          text: marker,
        },
      }),
    },
  });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, {
      body: JSON.stringify(executeFragment({ orgId: marker })),
    });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.state, 'WAITING_RECONCILE');
    assert.equal(result.reason, 'provider_unknown');
    assert.equal(Object.hasOwn(result, 'receipt'), false);
    assert.equal(response.body.includes(marker), false);
    assert.equal(controller.records[0].exited, true);
  } finally {
    await stopServer(running);
  }
});

test('a malformed outcome from the supervisor falls back to the conservative mapping', { timeout: 15000 }, async () => {
  const marker = 'TASK_BODY_MARKER_5e1';
  const supervisor = {
    admit: () => ({ ok: true }),
    start: async () => ({
      status: 'completed',
      exitCode: 0,
      outcome: {
        state: 'CHECKPOINTED',
        checkpoint: { refId: REF_ID, hash: HASH },
        receipt: { refId: ATTEMPT_ID, hash: `sha256:${'b'.repeat(64)}` },
        text: marker,
      },
    }),
  };
  const server = createAdvanceServer({
    supervisor,
    holderId: 'holder-test',
    cert: pki.cert,
    key: pki.key,
    ca: pki.ca,
    authz: authz.config,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  try {
    const response = await send(server.address().port, { body: JSON.stringify(baseFragment()) });
    assert.equal(response.status, 200);
    assert.equal(response.body.includes(marker), false);
    assert.equal(response.body.includes('CHECKPOINTED'), false);
    const result = JSON.parse(response.body);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.errorCode, 'runtime_fault');
    assert.equal(Object.hasOwn(result, 'receipt'), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('oversized bodies are rejected with body_too_large before parsing', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);
    assertError(await send(running.port, { body: oversized }), 413, 'body_too_large');
    assertError(await send(running.port, { body: oversized, chunked: true }), 413, 'body_too_large');
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('a wrong contractVersion returns version_mismatch without echoing the request', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    const marker = 'fragment_secret_marker_31c';
    const fragment = baseFragment({ contractVersion: 'work-runtime-fragment-v2', orgId: marker });
    const response = await send(running.port, { body: JSON.stringify(fragment) });
    assertError(response, 422, 'version_mismatch');
    assert.equal(response.body.includes(marker), false);
    assert.equal(response.body.includes(EXECUTION_ID), false);
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('unknown fields return invalid_request without spawning', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    const fragment = baseFragment({ executionId: 'fragment_secret_marker_31c' });
    fragment.holderId = 'attacker-chosen-holder';
    const response = await send(running.port, { body: JSON.stringify(fragment) });
    assertError(response, 422, 'invalid_request');
    assert.equal(response.body.includes('fragment_secret_marker_31c'), false);
    assert.equal(response.body.includes('attacker-chosen-holder'), false);

    const nested = executeFragment();
    nested.intent.extra = 'not-in-the-contract';
    const nestedResponse = await send(running.port, { body: JSON.stringify(nested) });
    assertError(nestedResponse, 422, 'invalid_request');
    assert.equal(nestedResponse.body.includes('not-in-the-contract'), false);
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('capacity 1 refuses a second fragment with resource_exhausted without spawning', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'hang' });
  const running = await startServer(controller, { maxConcurrent: 1 });
  const first = send(running.port, {
    body: JSON.stringify(baseFragment({ runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
  }).catch(() => undefined);
  try {
    await waitFor(() => controller.records.length === 1 && controller.records[0].pid !== undefined);
    const second = await send(running.port, {
      body: JSON.stringify(baseFragment({ runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })),
    });
    assertError(second, 429, 'resource_exhausted');
    await delay(100);
    assert.equal(controller.records.length, 1);
    assert.equal(running.supervisor.activeCount, 1);
  } finally {
    await stopServer(running);
    await first;
  }
});

test('a draining supervisor returns draining without spawning', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    await running.supervisor.drain();
    const response = await send(running.port, { body: JSON.stringify(baseFragment()) });
    assertError(response, 503, 'draining');
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('a runtimeVersion mismatch returns version_mismatch without spawning', { timeout: 15000 }, async () => {
  const controller = recordingSpawn({ behavior: 'ok' });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, {
      body: JSON.stringify(baseFragment({ runtimeVersion: 'runtime-v2' })),
    });
    assertError(response, 422, 'version_mismatch');
    assert.equal(controller.records.length, 0);
  } finally {
    await stopServer(running);
  }
});
