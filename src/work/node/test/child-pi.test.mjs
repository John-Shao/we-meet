import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCapabilityRefresher, createLineReader } from '../src/capability-refresh.mjs';
import { createContentClient } from '../src/content-client.mjs';
import { createGatewayClient } from '../src/gateway-client.mjs';
import { CONTRACT_VERSION, runAdvance, runPiTurn } from '../src/child-pi.mjs';

const CHILD = fileURLToPath(new URL('../src/child-pi.mjs', import.meta.url));
const ORG = 'org_runtime';
const EXECUTION = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '44444444-4444-4444-8444-444444444444';
const OPERATION = '55555555-5555-4555-8555-555555555555';
const ATTEMPT = '66666666-6666-4666-8666-666666666666';
const CHECKPOINT_REF = '77777777-7777-4777-8777-777777777777';
const REQUEST_REF = '88888888-8888-4888-8888-888888888888';
const INPUT_REF = '99999999-9999-4999-8999-999999999999';
const TEMPLATE_REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT_REF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECKPOINT_HASH = `sha256:${'c'.repeat(64)}`;
const RECEIPT_HASH = `sha256:${'d'.repeat(64)}`;
const SYSTEM_TEXT = 'SYSTEM-TEMPLATE-MARKER-7f3a';
const USER_TEXT = 'USER-INPUT-MARKER-91bc';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function docHash(document) {
  return `sha256:${createHash('sha256')
    .update(`${document.schemaVersion}\n${canonical(document)}`)
    .digest('hex')}`;
}

const userBytes = Buffer.from(USER_TEXT, 'utf8');
const systemBytes = Buffer.from(SYSTEM_TEXT, 'utf8');

const requestDocument = {
  kind: 'model_request',
  schemaVersion: 'work-model-request-v1',
  binding: {
    orgId: ORG,
    taskId: TASK,
    runId: RUN,
    snapshotId: SNAPSHOT,
    runtimeVersion: 'runtime-v1',
  },
  logicalKey: 'model:1',
  input: { refId: INPUT_REF, hash: sha256(userBytes) },
  template: { refId: TEMPLATE_REF, hash: sha256(systemBytes) },
  priorReceipts: [],
  route: {
    provider: 'aliyun',
    model: 'qwen-text',
    configRevision: '1',
    compatProfileVersion: 'v1',
  },
  parameters: {
    maxOutputTokens: 2048,
    temperatureMilli: 500,
    outputFormat: 'markdown',
  },
};
const requestBytes = Buffer.from(JSON.stringify(requestDocument), 'utf8');
const requestHash = docHash(requestDocument);

function executePayload(overrides = {}) {
  return {
    kind: 'advance_request',
    contractVersion: CONTRACT_VERSION,
    executionId: EXECUTION,
    runId: RUN,
    taskId: TASK,
    orgId: ORG,
    snapshotId: SNAPSHOT,
    runtimeVersion: 'runtime-v1',
    fence: '7',
    deadlineUnixMs: Date.now() + 60_000,
    mode: 'execute',
    checkpoint: { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH },
    intent: {
      request: { refId: REQUEST_REF, hash: requestHash },
      requestHash,
      logicalKey: 'model:1',
    },
    permit: {
      operationId: OPERATION,
      dispatchAttemptId: ATTEMPT,
      requestHash,
    },
    ...overrides,
  };
}

function planPayload(overrides = {}) {
  return {
    ...executePayload(),
    mode: 'plan',
    checkpoint: null,
    intent: null,
    permit: null,
    ...overrides,
  };
}

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
      handler(req, res, requests.length, requests[requests.length - 1]);
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

function contentServer({
  requestBody = requestBytes,
  extraBodies = new Map(),
  checkpointStatus = 201,
  checkpointCode = null,
} = {}) {
  const bodies = new Map([
    [REQUEST_REF, requestBody],
    [INPUT_REF, userBytes],
    [TEMPLATE_REF, systemBytes],
    ...extraBodies,
  ]);
  return startServer((req, res, _index, record) => {
    if (req.method === 'POST' && req.url === '/internal/v1/checkpoints') {
      if (checkpointStatus !== 201) {
        res.writeHead(checkpointStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: checkpointCode }));
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ref_id: req.headers['x-work-ref-id'],
        content_hash: req.headers['x-work-content-hash'],
        bytes: Buffer.byteLength(record.body, 'utf8'),
      }));
      return;
    }
    const match = /^\/internal\/v1\/content\/([0-9a-f-]{36})$/.exec(req.url);
    const body = match === null ? undefined : bodies.get(match[1]);
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'content_reference_not_found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
}

function gatewayServer({ status = 200, body } = {}) {
  return startServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? {
      receipt: { refId: RECEIPT_REF, hash: RECEIPT_HASH },
      usage: { source: 'provider', input: 21, output: 13, totalTokens: 34 },
    }));
  });
}

function clients(content, gateway) {
  return {
    contentClient: createContentClient({
      baseUrl: content.baseUrl,
      token: 'content-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
    }),
    gatewayClient: createGatewayClient({
      baseUrl: gateway.baseUrl,
      token: 'egress-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
    }),
  };
}

test('execute assembles system+user messages and runs one Pi turn through the gateway', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  try {
    const { contentClient, gatewayClient } = clients(content, gateway);
    let seenMessages = null;
    const outcome = await runAdvance(executePayload(), {
      contentClient,
      gatewayClient,
      runPiTurn: async (args) => {
        seenMessages = args.messages;
        assert.equal(typeof args.streamFn, 'function');
        return runPiTurn(args);
      },
    });

    assert.equal(outcome.state, 'CHECKPOINTED');
    assert.deepEqual(outcome.receipt, { refId: RECEIPT_REF, hash: RECEIPT_HASH });
    assert.equal(outcome.operationId, OPERATION);
    assert.deepEqual(outcome.usage, {
      source: 'provider',
      inputTokens: 21,
      outputTokens: 13,
      cachedInputTokens: 0,
    });

    assert.equal(seenMessages.length, 1);
    assert.equal(seenMessages[0].role, 'user');
    assert.equal(seenMessages[0].content, 'Execute the bound model request.');

    // Execute holds only the work-egress capability (D4 §6.2): it reads no
    // content and writes no checkpoint candidate. The control plane builds the
    // canonical successor from the verified receipt and answer.
    assert.equal(content.requests.length, 0);
    assert.deepEqual(outcome.checkpoint, { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH });

    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].url, '/runtime/v1/model/invoke');
    const gatewayBody = JSON.parse(gateway.requests[0].body);
    assert.deepEqual(gatewayBody, {
      executionId: EXECUTION,
      requestRef: { refId: REQUEST_REF, hash: requestHash },
      requestHash,
    });
    assert.equal(gateway.requests[0].body.includes(SYSTEM_TEXT), false);
    assert.equal(gateway.requests[0].body.includes(USER_TEXT), false);
    assert.equal(JSON.stringify(outcome).includes(SYSTEM_TEXT), false);
    assert.equal(JSON.stringify(outcome).includes(USER_TEXT), false);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('a refresh frame swaps both credentials and stale or malformed frames are ignored', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  try {
    const { contentClient, gatewayClient } = clients(content, gateway);
    const refresher = createCapabilityRefresher();
    refresher.attach({ contentClient, gatewayClient });

    refresher.applyLine(JSON.stringify({
      content: { baseUrl: content.baseUrl, token: 'content-token-2', generation: 2 },
    }));
    refresher.applyLine(JSON.stringify({
      egress: { baseUrl: gateway.baseUrl, token: 'egress-token-2', generation: 2 },
    }));

    await contentClient.get(INPUT_REF, sha256(userBytes));
    assert.equal(content.requests.at(-1).headers.authorization, 'Bearer content-token-2');
    assert.equal(content.requests.at(-1).headers['x-work-generation'], '2');

    const outcome = await gatewayClient.call({ executionId: EXECUTION });
    assert.equal(outcome.outcome, 'success');
    assert.equal(gateway.requests.at(-1).headers.authorization, 'Bearer egress-token-2');
    assert.equal(gateway.requests.at(-1).headers['x-work-generation'], '2');

    // Stale generation, truncated JSON, a moved base URL and an extra field
    // must all leave the previous credential in place.
    refresher.applyLine(JSON.stringify({
      content: { baseUrl: content.baseUrl, token: 'stale-token', generation: 1 },
    }));
    refresher.applyLine('{"content":');
    refresher.applyLine(JSON.stringify({
      content: { baseUrl: 'http://127.0.0.1:1', token: 'moved-token', generation: 3 },
    }));
    refresher.applyLine(JSON.stringify({
      content: { baseUrl: content.baseUrl, token: 'extra-token', generation: 4, scope: 'x' },
    }));
    refresher.applyLine(JSON.stringify({ egress: { baseUrl: gateway.baseUrl, token: 'stale', generation: 2 } }));

    await contentClient.get(INPUT_REF, sha256(userBytes));
    assert.equal(content.requests.at(-1).headers.authorization, 'Bearer content-token-2');
    assert.equal(content.requests.at(-1).headers['x-work-generation'], '2');
    const after = await gatewayClient.call({ executionId: EXECUTION });
    assert.equal(after.outcome, 'success');
    assert.equal(gateway.requests.at(-1).headers.authorization, 'Bearer egress-token-2');
    assert.equal(gateway.requests.at(-1).headers['x-work-generation'], '2');
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('an oversized refresh line is discarded and the next line still applies', () => {
  const lines = [];
  const reader = createLineReader({ maxLineBytes: 96, onLine: (line) => lines.push(line) });
  reader.push(Buffer.from('x'.repeat(200)));
  reader.push(Buffer.from('\n{"content":{"baseUrl":"http://127.0.0.1:1","token":"t","generation":2}}\n'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).content.generation, 2);
});

test('without a refresh the next call fails closed as capability_expired', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  let clock = 0;
  const now = () => clock;
  try {
    const contentClient = createContentClient({
      baseUrl: content.baseUrl,
      token: 'content-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
      capabilityTtlMs: 100,
      now,
    });
    const gatewayClient = createGatewayClient({
      baseUrl: gateway.baseUrl,
      token: 'egress-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
      capabilityTtlMs: 100,
      now,
    });
    clock = 100;

    await assert.rejects(
      contentClient.get(INPUT_REF, sha256(userBytes)),
      (error) => error.code === 'capability_expired',
    );
    assert.equal(content.requests.length, 0);

    const outcome = await gatewayClient.call({ executionId: EXECUTION });
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.code, 'capability_expired');
    assert.equal(gateway.requests.length, 0);

    // The advance surface reports the same terminal code instead of sending an
    // expired bearer or inventing a checkpoint.
    const advance = await runAdvance(planPayload({
      checkpoint: { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH },
    }), { contentClient });
    assert.equal(advance.state, 'FAILED');
    assert.equal(advance.errorCode, 'capability_expired');
    assert.equal(content.requests.length, 0);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('execute succeeds without a content capability and never reads content', async () => {
  const content = await contentServer({
    checkpointStatus: 500,
    checkpointCode: 'should_not_write',
  });
  const gateway = await gatewayServer();
  try {
    const { gatewayClient } = clients(content, gateway);
    const outcome = await runAdvance(executePayload(), { gatewayClient });
    assert.equal(outcome.state, 'CHECKPOINTED');
    assert.deepEqual(outcome.checkpoint, { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH });
    assert.deepEqual(outcome.receipt, { refId: RECEIPT_REF, hash: RECEIPT_HASH });
    assert.equal(content.requests.length, 0);
    assert.equal(gateway.requests.length, 1);
    assert.equal(JSON.stringify(outcome).includes(SYSTEM_TEXT), false);
    assert.equal(JSON.stringify(outcome).includes(USER_TEXT), false);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('unknown gateway outcome becomes WAITING_RECONCILE, never a receipt', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer({ status: 503, body: { code: 'draining' } });
  try {
    const outcome = await runAdvance(executePayload(), clients(content, gateway));
    assert.equal(outcome.state, 'WAITING_RECONCILE');
    assert.deepEqual(outcome.checkpoint, { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH });
    assert.equal(outcome.operationId, OPERATION);
    assert.equal(outcome.reason, 'provider_unknown');
    assert.equal(outcome.receipt, null);
    assert.deepEqual(outcome.usage, {
      source: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    assert.equal(gateway.requests.length, 1);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('a provable gateway rejection fails without a receipt', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer({
    status: 422,
    body: { code: 'request_hash_mismatch' },
  });
  try {
    const outcome = await runAdvance(executePayload(), clients(content, gateway));
    assert.equal(outcome.state, 'FAILED');
    assert.equal(outcome.reason, 'runtime_fault');
    assert.equal(outcome.errorCode, 'request_hash_mismatch');
    assert.equal(outcome.receipt, null);
    assert.equal(gateway.requests.length, 1);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('a bound rejected_not_executed receipt fails as provider_rejected', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer({
    body: {
      outcome: 'rejected_not_executed',
      sent: true,
      gateState: 'receipt_recorded',
      code: 'unprocessable',
      receipt: { refId: RECEIPT_REF, hash: RECEIPT_HASH },
      usage: { source: 'provider', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    },
  });
  try {
    const outcome = await runAdvance(executePayload(), clients(content, gateway));
    assert.equal(outcome.state, 'FAILED');
    assert.equal(outcome.reason, 'provider_rejected');
    assert.equal(outcome.errorCode, 'unprocessable');
    assert.equal(outcome.receipt, null);
    assert.equal('artifact' in outcome, false);
    assert.equal(gateway.requests.length, 1);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('execute rejects a request reference hash that differs from the intent hash', async () => {
  const payload = executePayload();
  payload.intent.request = { ...payload.intent.request, hash: `sha256:${'e'.repeat(64)}` };
  const outcome = await runAdvance(payload);
  assert.equal(outcome.state, 'FAILED');
  assert.equal(outcome.reason, 'invalid_context');
  assert.equal(outcome.errorCode, 'request_hash_mismatch');
});

test('execute tolerates an unreachable content proxy', async () => {
  const gateway = await gatewayServer();
  try {
    const gatewayClient = createGatewayClient({
      baseUrl: gateway.baseUrl,
      token: 'egress-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
    });
    const unreachable = createContentClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'content-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
    });
    const outcome = await runAdvance(executePayload(), {
      contentClient: unreachable,
      gatewayClient,
    });
    assert.equal(outcome.state, 'CHECKPOINTED');
    assert.equal(gateway.requests.length, 1);
  } finally {
    await gateway.close();
  }
});

test('the runPiTurn seam fails closed when it never reaches the gateway', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  try {
    const outcome = await runAdvance(executePayload(), {
      ...clients(content, gateway),
      runPiTurn: async () => ({ messages: [], message: null, events: [] }),
    });
    assert.equal(outcome.state, 'FAILED');
    assert.equal(outcome.reason, 'runtime_fault');
    assert.equal(outcome.errorCode, 'pi_turn_without_gateway_call');
    assert.equal(gateway.requests.length, 0);
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('plan without a checkpoint fails invalid_context; a pending checkpoint yields MODEL_REQUEST', async () => {
  const without = await runAdvance(planPayload());
  assert.equal(without.state, 'FAILED');
  assert.equal(without.reason, 'invalid_context');

  const noCapability = await runAdvance(planPayload({
    checkpoint: { refId: CHECKPOINT_REF, hash: CHECKPOINT_HASH },
  }));
  assert.equal(noCapability.state, 'FAILED');
  assert.equal(noCapability.reason, 'runtime_fault');
  assert.equal(noCapability.errorCode, 'capability_unavailable');

  const canonicalState = {
    kind: 'canonical_state',
    schemaVersion: 'work-canonical-v1',
    binding: {
      orgId: ORG,
      taskId: TASK,
      runId: RUN,
      snapshotId: SNAPSHOT,
      runtimeVersion: 'runtime-v1',
    },
    revision: 0,
    previous: null,
    writerExecutionId: EXECUTION,
    input: { refId: INPUT_REF, hash: sha256(userBytes) },
    template: { refId: TEMPLATE_REF, hash: sha256(systemBytes) },
    completedModels: [],
    phase: 'awaiting_model',
    pending: {
      request: { refId: REQUEST_REF, hash: requestHash },
      requestHash,
      logicalKey: 'model:1',
    },
    artifact: null,
  };
  const checkpointHash = docHash(canonicalState);
  const content = await contentServer({
    extraBodies: new Map([[CHECKPOINT_REF, Buffer.from(JSON.stringify(canonicalState))]]),
  });
  try {
    const contentClient = createContentClient({
      baseUrl: content.baseUrl,
      token: 'content-token',
      org: ORG,
      execution: EXECUTION,
      generation: 1,
    });
    const withPending = await runAdvance(planPayload({
      checkpoint: { refId: CHECKPOINT_REF, hash: checkpointHash },
    }), { contentClient });
    assert.equal(withPending.state, 'MODEL_REQUEST');
    assert.deepEqual(withPending.checkpoint, { refId: CHECKPOINT_REF, hash: checkpointHash });
    assert.deepEqual(withPending.intent, {
      request: { refId: REQUEST_REF, hash: requestHash },
      requestHash,
      logicalKey: 'model:1',
    });
    assert.equal(withPending.receipt, null);
  } finally {
    await content.close();
  }
});

const BASE_ENV = {
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  HOME: process.env.HOME,
};

function spawnChild({ env, payload, bootstrap, refreshLines = [], timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...BASE_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const frames = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`child timeout; stderr=${stderr}`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.type === 'hello') {
        child.stdin.write(`${JSON.stringify({ v: 1, type: 'run' })}\n`);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ frames, code, signal, stderr });
    });

    child.stdio[3].end(JSON.stringify(payload));
    child.stdio[4].end(bootstrap === undefined ? '' : JSON.stringify(bootstrap));
    child.stdio[5].end(refreshLines.map((line) => `${line}\n`).join(''));
  });
}

test('child speaks hello/run/result with WORK_CHILD_NONCE and no plan checkpoint', async () => {
  const result = await spawnChild({
    env: { WORK_RUN_ID: RUN, WORK_CHILD_NONCE: 'nonce-1234' },
    payload: planPayload(),
  });
  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames[0], {
    v: 1,
    type: 'hello',
    runId: RUN,
    nonce: 'nonce-1234',
  });
  assert.deepEqual(result.frames[1], {
    v: 1,
    type: 'result',
    status: 'failed',
    outcome: { state: 'FAILED', checkpoint: null, reason: 'invalid_context' },
  });
  assert.deepEqual(Object.keys(result.frames[1]).sort(), ['outcome', 'status', 'type', 'v']);
  assert.equal(result.code, 1);
});

test('child falls back to the existing supervisor WORK_RUN_NONCE', async () => {
  const result = await spawnChild({
    env: { WORK_RUN_ID: RUN, WORK_RUN_NONCE: 'nonce-supervisor' },
    payload: planPayload(),
  });
  assert.equal(result.frames[0].nonce, 'nonce-supervisor');
  assert.equal(result.frames[1].status, 'failed');
});

test('the spawned child reads a refresh from fd 5 before the first call', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  try {
    const result = await spawnChild({
      env: {
        WORK_RUN_ID: RUN,
        WORK_CHILD_NONCE: 'nonce-refresh',
        WORK_CHILD_BOOTSTRAP_FD: '4',
        WORK_CHILD_REFRESH_FD: '5',
      },
      payload: executePayload(),
      bootstrap: {
        content: { baseUrl: content.baseUrl, token: 'content-token', generation: 1 },
        egress: { baseUrl: gateway.baseUrl, token: 'egress-token', generation: 1 },
      },
      refreshLines: [
        JSON.stringify({ content: { baseUrl: content.baseUrl, token: 'content-token-2', generation: 2 } }),
        JSON.stringify({ egress: { baseUrl: gateway.baseUrl, token: 'egress-token-2', generation: 2 } }),
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.frames[1].outcome.state, 'CHECKPOINTED');
    // Execute has no content client, so the content refresh frame is dropped
    // and the content proxy is never contacted.
    assert.equal(content.requests.length, 0);
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer egress-token-2');
    assert.equal(gateway.requests[0].headers['x-work-generation'], '2');
  } finally {
    await content.close();
    await gateway.close();
  }
});

test('spawned execute path uses only the fake local servers, no provider key', async () => {
  const content = await contentServer();
  const gateway = await gatewayServer();
  const providerSentinels = {
    OPENAI_API_KEY: 'sk-provider-sentinel-111',
    ANTHROPIC_API_KEY: 'sk-ant-provider-sentinel-222',
    DASHSCOPE_API_KEY: 'dash-provider-sentinel-333',
  };
  try {
    const result = await spawnChild({
      env: {
        ...providerSentinels,
        WORK_RUN_ID: RUN,
        WORK_CHILD_NONCE: 'nonce-execute',
        WORK_CHILD_BOOTSTRAP_FD: '4',
      },
      payload: executePayload(),
      bootstrap: {
        content: { baseUrl: content.baseUrl, token: 'content-token', generation: 1 },
        egress: { baseUrl: gateway.baseUrl, token: 'egress-token', generation: 1 },
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.frames.length, 2);
    const resultFrame = result.frames[1];
    assert.equal(resultFrame.v, 1);
    assert.equal(resultFrame.type, 'result');
    assert.equal(resultFrame.status, 'completed');
    assert.equal(resultFrame.outcome.state, 'CHECKPOINTED');
    assert.deepEqual(resultFrame.outcome.receipt, { refId: RECEIPT_REF, hash: RECEIPT_HASH });
    assert.equal(JSON.stringify(result.frames).includes(SYSTEM_TEXT), false);
    assert.equal(JSON.stringify(result.frames).includes(USER_TEXT), false);

    assert.equal(content.requests.length, 0);
    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(resultFrame.outcome.checkpoint, {
      refId: CHECKPOINT_REF,
      hash: CHECKPOINT_HASH,
    });
    const observed = JSON.stringify([
      ...content.requests.map((request) => ({ headers: request.headers, body: request.body })),
      ...gateway.requests.map((request) => ({ headers: request.headers, body: request.body })),
    ]);
    for (const sentinel of Object.values(providerSentinels)) {
      assert.equal(observed.includes(sentinel), false);
    }

    const source = await readFile(CHILD, 'utf8');
    assert.equal(/API_KEY/.test(source), false);
    assert.equal(/OPENAI|ANTHROPIC|DASHSCOPE/.test(source), false);
  } finally {
    await content.close();
    await gateway.close();
  }
});
