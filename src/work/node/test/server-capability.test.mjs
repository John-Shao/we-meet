import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { CONTRACT_VERSION, ROUTE, createAdvanceServer } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { recordingSpawn, waitFor } from '../test-support/helpers.mjs';
import { createFakeAuthz } from '../test-support/fake-authz.mjs';
import { createTLSFixture } from '../test-support/tls.mjs';

const CHILD = fileURLToPath(new URL('../test-support/child-capability-stub.mjs', import.meta.url));
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
    orgId: 'org_capability',
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

function send(port, body) {
  const payload = Buffer.from(body, 'utf8');
  const options = {
    host: '127.0.0.1',
    port,
    path: ROUTE,
    method: 'POST',
    ca: pki.ca,
    servername: 'localhost',
    cert: pki.clientCert,
    key: pki.clientKey,
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
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

async function readRecord(file) {
  await waitFor(async () => {
    try {
      return (await readFile(file, 'utf8')).length > 0;
    } catch {
      return false;
    }
  });
  return JSON.parse(await readFile(file, 'utf8'));
}

// The handler may override one command; returning undefined falls back to the
// fake's signed-shape default (claim=claimed, renew=active, issue=token).
function authzRespond(overrides = {}) {
  return (record) => {
    const command = record.path.split('/').pop();
    return overrides[command]?.(record);
  };
}

function findRequest(command) {
  return authz.requests.find((record) => record.path.endsWith(`/${command}`));
}

test('a plan run receives the work-content capability on fd 4', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-capability-'));
  const recordFile = join(dir, 'child.json');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  authz.reset();
  const token = 'content-token-marker-31c';
  authz.setRespond(authzRespond({
    issue_capability: () => ({
      status: 200,
      body: { token, generation: 3, expires_at: new Date(Date.now() + 30_000).toISOString() },
    }),
  }));
  const controller = recordingSpawn({
    childScript: CHILD,
    env: { WORK_STUB_CAP_FILE: recordFile },
  });
  const running = await startServer(controller);
  try {
    const fragment = baseFragment();
    const response = await send(running.port, JSON.stringify(fragment));
    assert.equal(response.status, 200, response.body);
    assert.equal(JSON.parse(response.body).state, 'FAILED');
    assert.equal(response.body.includes(token), false);

    const record = await readRecord(recordFile);
    assert.equal(record.pid, controller.records[0].pid);
    assert.equal(record.bootstrapRaw, JSON.stringify({ content: { baseUrl: 'http://127.0.0.1:8444', token, generation: 3 } }));
    assert.equal(record.payloadRaw, JSON.stringify(fragment));
    assert.equal(JSON.stringify(record.frames).includes(token), false);
    assert.equal(JSON.stringify(record.env).includes(token), false);
    assert.equal(JSON.stringify(record.argv).includes(token), false);

    // The parent claims before a capability exists, and only then issues.
    const claimRequest = findRequest('claim_runtime_execution');
    const issueRequest = findRequest('issue_capability');
    assert.ok(claimRequest);
    assert.ok(issueRequest);
    assert.ok(authz.requests.indexOf(claimRequest) < authz.requests.indexOf(issueRequest));
    assert.equal(claimRequest.method, 'POST');
    assert.equal(claimRequest.authorized, true);
    assert.deepEqual(claimRequest.body, {
      org_id: 'org_capability',
      execution_id: EXECUTION_ID,
    });
    assert.equal(issueRequest.path, '/internal/v1/commands/issue_capability');
    assert.equal(issueRequest.method, 'POST');
    assert.equal(issueRequest.authorized, true);
    assert.deepEqual(issueRequest.body, {
      org_id: 'org_capability',
      execution_id: EXECUTION_ID,
      audience: 'work-content',
    });
    assert.equal(JSON.stringify(issueRequest.body).includes(token), false);
  } finally {
    await stopServer(running);
  }
});

test('an execute run receives only the work-egress capability on fd 4', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-capability-'));
  const recordFile = join(dir, 'child.json');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  authz.reset();
  const egressToken = 'egress-token-marker-42d';
  authz.setRespond(authzRespond({
    issue_capability: () => ({
      status: 200,
      body: { token: egressToken, generation: 1, expires_at: new Date(Date.now() + 30_000).toISOString() },
    }),
  }));
  const controller = recordingSpawn({
    childScript: CHILD,
    env: { WORK_STUB_CAP_FILE: recordFile },
  });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, JSON.stringify(executeFragment()));
    assert.equal(response.status, 200, response.body);
    assert.equal(JSON.parse(response.body).state, 'WAITING_RECONCILE');

    const record = await readRecord(recordFile);
    assert.equal(record.bootstrapRaw, JSON.stringify({ egress: { baseUrl: 'http://127.0.0.1:8445', token: egressToken, generation: 1 } }));
    assert.equal(JSON.stringify(record.frames).includes(egressToken), false);
    assert.equal(JSON.stringify(record.env).includes(egressToken), false);
    assert.equal(JSON.stringify(record.argv).includes(egressToken), false);
    assert.equal(response.body.includes(egressToken), false);

    assert.deepEqual(findRequest('claim_runtime_execution').body, {
      org_id: 'org_capability',
      execution_id: EXECUTION_ID,
    });
    const issues = authz.requests.filter((request) => request.path.endsWith('/issue_capability'));
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].body, {
      org_id: 'org_capability',
      execution_id: EXECUTION_ID,
      audience: 'work-egress',
    });
  } finally {
    await stopServer(running);
  }
});

for (const [name, status, body] of [
  ['4xx', 403, { code: 'caller_not_permitted' }],
  ['5xx', 500, { code: 'internal_error' }],
]) {
  test(`issuance ${name} refuses the run without spawning a child`, { timeout: 15000 }, async () => {
    authz.reset();
    authz.setRespond(authzRespond({
      issue_capability: () => ({ status, body }),
    }));
    const controller = recordingSpawn({ childScript: CHILD });
    const running = await startServer(controller);
    try {
      const response = await send(running.port, JSON.stringify(baseFragment()));
      assertError(response, 503, 'capability_unavailable');
      assert.equal(controller.records.length, 0);
      assert.equal(running.supervisor.activeCount, 0);
      assert.equal(JSON.stringify(response.body).includes('caller_not_permitted'), false);
      // The claim succeeded; only issuance failed, and no child was spawned.
      assert.ok(findRequest('claim_runtime_execution'));
      assert.deepEqual(findRequest('issue_capability').body, {
        org_id: 'org_capability',
        execution_id: EXECUTION_ID,
        audience: 'work-content',
      });
    } finally {
      await stopServer(running);
    }
  });
}

test('a malformed issuance response refuses the run without spawning a child', { timeout: 15000 }, async () => {
  authz.reset();
  authz.setRespond(authzRespond({
    issue_capability: () => ({
      status: 200,
      body: { token: 'not-delivered', generation: 1 },
    }),
  }));
  const controller = recordingSpawn({ childScript: CHILD });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, JSON.stringify(baseFragment()));
    assertError(response, 503, 'capability_unavailable');
    assert.equal(controller.records.length, 0);
    assert.equal(JSON.stringify(response.body).includes('not-delivered'), false);
    assert.ok(findRequest('claim_runtime_execution'));
  } finally {
    await stopServer(running);
  }
});
