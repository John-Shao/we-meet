import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';

import { CONTRACT_VERSION, ROUTE, createAdvanceServer } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { isAlive, recordingSpawn, waitFor } from '../test-support/helpers.mjs';
import { createFakeAuthz } from '../test-support/fake-authz.mjs';
import { createTLSFixture } from '../test-support/tls.mjs';

const CAP_CHILD = fileURLToPath(new URL('../test-support/child-capability-stub.mjs', import.meta.url));
const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const REF_ID = '77777777-7777-4777-8777-777777777777';
const HASH = `sha256:${'a'.repeat(64)}`;
const HOLDER = 'holder-test';
const TOKEN = 'lease-token-marker-77a';

let pki;
let authz;

before(async () => {
  pki = await createTLSFixture();
  authz = await createFakeAuthz(pki, { holderId: HOLDER });
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
    orgId: 'org_lease',
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

function issueBody(token = TOKEN) {
  return () => ({
    status: 200,
    body: { token, generation: 1, expires_at: new Date(Date.now() + 30_000).toISOString() },
  });
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

// Override individual commands; returning undefined falls back to the fake's
// signed-shape default. This keeps every test explicit about the one command
// it changes without re-stating the other two.
function installAuthz(overrides = {}) {
  authz.setRespond((record) => {
    const command = record.path.split('/').pop();
    const override = overrides[command];
    return override === undefined ? undefined : override(record);
  });
}

function commandRequests(command) {
  return authz.requests.filter((record) => record.path.endsWith(`/${command}`));
}

function claimBody(state = 'claimed', holderId = HOLDER) {
  return {
    status: 200,
    body: { execution_id: EXECUTION_ID, holder_id: holderId, state },
  };
}

async function startServer(controller, { lease, supervisor: supervisorOverrides = {} } = {}) {
  const supervisor = new Supervisor({
    maxConcurrent: 2,
    runtimeVersion: 'runtime-v1',
    startTimeoutMs: 5000,
    runTimeoutMs: 15_000,
    killGraceMs: 150,
    spawn: controller.spawn,
    ...supervisorOverrides,
  });
  const server = createAdvanceServer({
    supervisor,
    holderId: HOLDER,
    cert: pki.cert,
    key: pki.key,
    ca: pki.ca,
    authz: authz.config,
    lease,
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
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
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
    req.setTimeout(12000, () => req.destroy(new Error('client_timeout')));
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

async function readRecordWhen(file, predicate) {
  await waitFor(async () => {
    try {
      return predicate(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return false;
    }
  });
  return JSON.parse(await readFile(file, 'utf8'));
}

function hangCapChild(dir, env = {}) {
  return recordingSpawn({
    childScript: CAP_CHILD,
    env: { WORK_STUB_CAP_FILE: join(dir, 'child.json'), WORK_STUB_CAP_HANG: '1', ...env },
  });
}

test('claim happens before issuance and spawn, with the signed thin wire', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({ issue_capability: issueBody() });
  const controller = recordingSpawn({
    childScript: CAP_CHILD,
    env: { WORK_STUB_CAP_FILE: join(dir, 'child.json') },
  });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, baseFragment());
    assert.equal(response.status, 200, response.body);

    const claims = commandRequests('claim_runtime_execution');
    const issues = commandRequests('issue_capability');
    assert.equal(claims.length, 1);
    assert.equal(issues.length, 1);
    assert.ok(authz.requests.indexOf(claims[0]) < authz.requests.indexOf(issues[0]));
    assert.equal(claims[0].authorized, true);
    assert.deepEqual(claims[0].body, {
      org_id: 'org_lease',
      execution_id: EXECUTION_ID,
    });
    assert.equal(controller.records.length, 1);
    // §6.2: the claim wire names only the execution; the holder is minted by
    // the authorization service and bound to the authenticated workload.
    assert.equal(Object.hasOwn(claims[0].body, 'holder_id'), false);
  } finally {
    await stopServer(running);
  }
});

test('already_claimed by the configured holder is accepted', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({
    claim_runtime_execution: () => claimBody('already_claimed'),
    issue_capability: issueBody(),
  });
  const controller = recordingSpawn({
    childScript: CAP_CHILD,
    env: { WORK_STUB_CAP_FILE: join(dir, 'child.json') },
  });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, baseFragment());
    assert.equal(response.status, 200, response.body);
    assert.equal(controller.records.length, 1);
    assert.equal(commandRequests('issue_capability').length, 1);
  } finally {
    await stopServer(running);
  }
});

for (const [name, claimResponse] of [
  ['already_claimed naming another holder', () => claimBody('already_claimed', 'other-holder')],
  ['a remote holder-mismatch refusal', () => ({ status: 403, body: { code: 'runtime_execution_holder_mismatch' } })],
]) {
  test(`${name} refuses the run before any capability or child`, { timeout: 15000 }, async () => {
    authz.reset();
    installAuthz({ claim_runtime_execution: claimResponse });
    const controller = recordingSpawn({ childScript: CAP_CHILD });
    const running = await startServer(controller);
    try {
      const response = await send(running.port, baseFragment());
      assertError(response, 409, 'lease_holder_mismatch');
      assert.equal(controller.records.length, 0);
      assert.equal(commandRequests('issue_capability').length, 0);
      assert.equal(running.supervisor.activeCount, 0);
      assert.equal(response.body.includes('other-holder'), false);
    } finally {
      await stopServer(running);
    }
  });
}

test('a claim 5xx refuses the run before any capability or child', { timeout: 15000 }, async () => {
  authz.reset();
  installAuthz({
    claim_runtime_execution: () => ({ status: 500, body: { code: 'internal_error' } }),
  });
  const controller = recordingSpawn({ childScript: CAP_CHILD });
  const running = await startServer(controller);
  try {
    const response = await send(running.port, baseFragment());
    assertError(response, 503, 'lease_unavailable');
    assert.equal(controller.records.length, 0);
    assert.equal(commandRequests('issue_capability').length, 0);
    assert.equal(running.supervisor.activeCount, 0);
  } finally {
    await stopServer(running);
  }
});

test('renews every heartbeat with a monotonic sequence and the claimed holder', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({ issue_capability: issueBody() });
  const controller = hangCapChild(dir);
  const running = await startServer(controller, { lease: { heartbeatIntervalMs: 60 } });
  let pending;
  try {
    pending = send(running.port, baseFragment());
    await waitFor(() => commandRequests('renew_runtime_execution').length >= 3);
    const renews = commandRequests('renew_runtime_execution');
    assert.equal(isAlive(controller.records[0].pid), true);
    for (let index = 0; index < renews.length; index += 1) {
      assert.deepEqual(renews[index].body, {
        org_id: 'org_lease',
        execution_id: EXECUTION_ID,
        holder_id: HOLDER,
        heartbeat_seq: index + 1,
      });
      assert.equal(JSON.stringify(renews[index].body).includes(TOKEN), false);
    }
    assert.equal(JSON.stringify(authz.requests).includes(TOKEN), false);
  } finally {
    await running.supervisor.shutdown({ force: true });
    if (pending !== undefined) await pending;
    await stopServer(running);
  }
});

test('a renewal returning expired kills the child and settles lease_lost', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({
    issue_capability: issueBody(),
    renew_runtime_execution: () => ({
      status: 200,
      body: { execution_id: EXECUTION_ID, holder_id: HOLDER, state: 'expired' },
    }),
  });
  const controller = hangCapChild(dir, { WORK_STUB_IGNORE_SIGTERM: '1' });
  const running = await startServer(controller, { lease: { heartbeatIntervalMs: 60 } });
  try {
    const response = await send(running.port, baseFragment());
    assert.equal(response.status, 200, response.body);
    const result = JSON.parse(response.body);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.errorCode, 'lease_lost');
    assert.equal(result.kind, 'advance_result');

    const record = controller.records[0];
    assert.equal(record.exited, true);
    // Windows emulates SIGTERM with TerminateProcess, so the graceful signal
    // already reaps the child there; the supervisor escalates to SIGKILL only
    // when SIGTERM does not land (Linux/production, covered by supervisor tests).
    assert.ok(record.signal === 'SIGTERM' || record.signal === 'SIGKILL');
    assert.equal(isAlive(record.pid), false);
    assert.equal(running.supervisor.activeCount, 0);
    // The loop stopped at the first loss: no renewal after settlement.
    assert.equal(commandRequests('renew_runtime_execution').length, 1);
  } finally {
    await stopServer(running);
  }
});

test('a lease loss during execute reconciles instead of reporting success', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({
    issue_capability: issueBody(),
    renew_runtime_execution: () => ({
      status: 200,
      body: { execution_id: EXECUTION_ID, holder_id: HOLDER, state: 'expired' },
    }),
  });
  const controller = hangCapChild(dir);
  const running = await startServer(controller, { lease: { heartbeatIntervalMs: 60 } });
  try {
    const response = await send(running.port, executeFragment());
    assert.equal(response.status, 200, response.body);
    const result = JSON.parse(response.body);
    // An execute fragment may already have consumed its gate, so the only safe
    // answer is reconciliation, never a fabricated success or failure.
    assert.equal(result.state, 'WAITING_RECONCILE');
    assert.equal(result.reason, 'provider_unknown');
    assert.equal(Object.hasOwn(result, 'errorCode'), false);
    assert.equal(controller.records[0].exited, true);
    assert.equal(isAlive(controller.records[0].pid), false);
  } finally {
    await stopServer(running);
  }
});

for (const [name, renewResponse] of [
  [
    'a renewal naming another holder',
    () => ({
      status: 200,
      body: {
        execution_id: EXECUTION_ID,
        holder_id: 'stolen-holder',
        state: 'active',
        lease_until: new Date(Date.now() + 30_000).toISOString(),
      },
    }),
  ],
  ['a renewal RPC failure', () => ({ status: 500, body: { code: 'internal_error' } })],
]) {
  test(`${name} kills the child and settles lease_lost`, { timeout: 15000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
    t.after(async () => rm(dir, { recursive: true, force: true }));
    authz.reset();
    installAuthz({
      issue_capability: issueBody(),
      renew_runtime_execution: renewResponse,
    });
    const controller = hangCapChild(dir);
    const running = await startServer(controller, { lease: { heartbeatIntervalMs: 60 } });
    try {
      const response = await send(running.port, baseFragment());
      assert.equal(response.status, 200, response.body);
      const result = JSON.parse(response.body);
      assert.equal(result.state, 'FAILED');
      assert.equal(result.errorCode, 'lease_lost');
      const record = controller.records[0];
      assert.equal(record.exited, true);
      assert.equal(isAlive(record.pid), false);
      assert.equal(commandRequests('renew_runtime_execution').length, 1);
    } finally {
      await stopServer(running);
    }
  });
}

test('the renewal loop stops once the child exits', { timeout: 15000 }, async () => {
  authz.reset();
  installAuthz({ issue_capability: issueBody() });
  const controller = recordingSpawn({
    behavior: 'ok',
    env: { WORK_STUB_DELAY_MS: '300' },
  });
  const running = await startServer(controller, { lease: { heartbeatIntervalMs: 50 } });
  try {
    const response = await send(running.port, baseFragment());
    assert.equal(response.status, 200, response.body);
    const renewsAtSettlement = commandRequests('renew_runtime_execution').length;
    assert.ok(renewsAtSettlement >= 1);
    assert.equal(controller.records[0].exited, true);

    await delay(250);
    assert.equal(commandRequests('renew_runtime_execution').length, renewsAtSettlement);
  } finally {
    await stopServer(running);
  }
});

test('the parent refreshes the capability on fd 5 with strictly increasing generations', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  const recordFile = join(dir, 'child.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({});
  const controller = hangCapChild(dir);
  const running = await startServer(controller, {
    lease: { heartbeatIntervalMs: 20_000, capabilityRefreshIntervalMs: 80 },
  });
  let pending;
  try {
    pending = send(running.port, baseFragment());
    const record = await readRecordWhen(recordFile, (value) => (value.refreshFrames?.length ?? 0) >= 2);
    assert.equal(isAlive(record.pid), true);
    assert.equal(controller.records[0].exited, false);

    const frames = record.refreshFrames.map((line) => JSON.parse(line));
    const initial = JSON.parse(record.bootstrapRaw);
    assert.ok(initial.content.generation >= 1);
    let previousGeneration = initial.content.generation;
    let previousToken = initial.content.token;
    for (const frame of frames) {
      assert.deepEqual(Object.keys(frame), ['content']);
      assert.deepEqual(Object.keys(frame.content).sort(),
        ['baseUrl', 'expiresAt', 'generation', 'token']);
      assert.ok(Number.isSafeInteger(frame.content.expiresAt) && frame.content.expiresAt > 0);
      assert.equal(frame.content.baseUrl, 'http://127.0.0.1:8444');
      assert.ok(frame.content.generation > previousGeneration);
      assert.ok(frame.content.token.length > 0);
      assert.notEqual(frame.content.token, previousToken);
      previousGeneration = frame.content.generation;
      previousToken = frame.content.token;
    }
  } finally {
    await running.supervisor.shutdown({ force: true });
    if (pending !== undefined) await pending;
    await stopServer(running);
  }
});

test('a refresh 4xx stops further sends and settles capability_refresh_failed', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  const recordFile = join(dir, 'child.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  let issued = 0;
  installAuthz({
    issue_capability: () => {
      issued += 1;
      if (issued === 1) return issueBody()();
      return { status: 403, body: { code: 'caller_not_permitted' } };
    },
  });
  const controller = hangCapChild(dir);
  const running = await startServer(controller, {
    lease: { heartbeatIntervalMs: 20_000, capabilityRefreshIntervalMs: 500 },
  });
  try {
    const pending = send(running.port, baseFragment());
    // Wait for the handshake record first so the assertion below observes the
    // state before the first refresh fires.
    const record = await readRecord(recordFile);
    const response = await pending;
    assert.equal(response.status, 200, response.body);
    const result = JSON.parse(response.body);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.errorCode, 'capability_refresh_failed');
    assert.equal(response.body.includes('caller_not_permitted'), false);

    assert.equal(controller.records[0].exited, true);
    assert.equal(isAlive(record.pid), false);
    assert.equal(running.supervisor.activeCount, 0);
    // The failed refresh was never written to the child, and the loop stopped
    // at the first failure: two issuances total (startup + failed refresh).
    assert.equal(record.refreshFrames.length, 0);
    assert.equal(commandRequests('issue_capability').length, 2);

    await delay(300);
    assert.equal(commandRequests('issue_capability').length, 2);
    assert.equal(record.refreshFrames.length, 0);
  } finally {
    await stopServer(running);
  }
});

test('refresh tokens never reach control frames, env, argv, logs or the result', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  const recordFile = join(dir, 'child.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  const tokens = [];
  installAuthz({
    issue_capability: () => {
      const token = `refresh-token-marker-${tokens.length + 1}`;
      tokens.push(token);
      return {
        status: 200,
        body: {
          token,
          generation: tokens.length,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      };
    },
  });
  const controller = hangCapChild(dir);
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });

  const running = await startServer(controller, {
    lease: { heartbeatIntervalMs: 20_000, capabilityRefreshIntervalMs: 80 },
  });
  let response;
  try {
    const pending = send(running.port, baseFragment());
    const record = await readRecordWhen(recordFile, (value) => (value.refreshFrames?.length ?? 0) >= 1);
    assert.ok(tokens.length >= 2);
    // The private pipes do carry the token: that is their only purpose.
    assert.equal(record.bootstrapRaw.includes(tokens[0]), true);
    assert.equal(record.refreshFrames.join('\n').includes(tokens[1]), true);

    await running.supervisor.shutdown({ force: true });
    response = await pending;
    assert.equal(response.status, 200, response.body);

    for (const token of tokens) {
      assert.equal(JSON.stringify(record.frames).includes(token), false);
      assert.equal(JSON.stringify(record.env).includes(token), false);
      assert.equal(JSON.stringify(record.argv).includes(token), false);
      assert.equal(JSON.stringify(authz.requests).includes(token), false);
      assert.equal(response.body.includes(token), false);
      assert.equal(logs.join('\n').includes(token), false);
    }
  } finally {
    await stopServer(running);
  }
});

test('capability tokens never reach frames, env, argv, logs or the settle result', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'work-lease-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  authz.reset();
  installAuthz({ issue_capability: issueBody() });
  const controller = recordingSpawn({
    childScript: CAP_CHILD,
    env: { WORK_STUB_CAP_FILE: join(dir, 'child.json') },
  });
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
  });

  const running = await startServer(controller);
  try {
    const response = await send(running.port, baseFragment());
    assert.equal(response.status, 200, response.body);

    const record = await readRecord(join(dir, 'child.json'));
    // Exactly one delivery path: the private fd 4 bootstrap.
    const bootstrap = JSON.parse(record.bootstrapRaw);
    assert.deepEqual(Object.keys(bootstrap), ['content']);
    assert.equal(bootstrap.content.baseUrl, 'http://127.0.0.1:8444');
    assert.equal(bootstrap.content.token, TOKEN);
    assert.equal(bootstrap.content.generation, 1);
    assert.ok(Number.isSafeInteger(bootstrap.content.expiresAt));
    assert.equal(JSON.stringify(record.frames).includes(TOKEN), false);
    assert.equal(JSON.stringify(record.env).includes(TOKEN), false);
    assert.equal(JSON.stringify(record.argv).includes(TOKEN), false);
    assert.equal(response.body.includes(TOKEN), false);
    assert.equal(JSON.stringify(authz.requests).includes(TOKEN), false);
    assert.equal(logs.join('\n').includes(TOKEN), false);
  } finally {
    await stopServer(running);
  }
});
