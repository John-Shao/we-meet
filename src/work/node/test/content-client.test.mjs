import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import { createContentClient, documentHash } from '../src/content-client.mjs';

const ORG = 'org_runtime';
const EXECUTION = '11111111-1111-4111-8111-111111111111';
const REF_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'opaque-content-token';

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
  return createContentClient({
    baseUrl: server.baseUrl,
    token: TOKEN,
    org: ORG,
    execution: EXECUTION,
    generation: 3,
    ...overrides,
  });
}

test('content client sends the four capability headers and verifies bytes', async () => {
  const body = Buffer.from('bound content body');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  try {
    const bytes = await client(server).get(REF_ID, sha256(body));
    assert.deepEqual(bytes, body);
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/internal/v1/content/${REF_ID}`);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['x-work-org'], ORG);
    assert.equal(request.headers['x-work-execution'], EXECUTION);
    assert.equal(request.headers['x-work-generation'], '3');
  } finally {
    await server.close();
  }
});

test('content client refuses a bytes hash mismatch', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('tampered body');
  });
  try {
    const expected = sha256(Buffer.from('expected body'));
    await assert.rejects(
      client(server).get(REF_ID, expected),
      (error) => error.code === 'content_hash_mismatch',
    );
  } finally {
    await server.close();
  }
});

test('content client refuses redirects without following them', async () => {
  let targetHits = 0;
  const server = await startServer((req, res) => {
    if (req.url === '/target') {
      targetHits += 1;
      res.writeHead(200);
      res.end('target');
      return;
    }
    res.writeHead(302, { Location: '/target' });
    res.end();
  });
  try {
    const expected = sha256(Buffer.from('target'));
    await assert.rejects(
      client(server).get(REF_ID, expected),
      (error) => error.code === 'redirect_refused' && error.status === 302,
    );
    assert.equal(targetHits, 0);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('content client surfaces the proxy code on 401', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'capability_invalid' }));
  });
  try {
    await assert.rejects(
      client(server).get(REF_ID, sha256(Buffer.from('x'))),
      (error) => error.code === 'capability_invalid' && error.status === 401,
    );
  } finally {
    await server.close();
  }
});

test('content client bounds the response body', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(64, 0x61));
  });
  try {
    const body = Buffer.alloc(64, 0x61);
    await assert.rejects(
      client(server, { maxBytes: 16 }).get(REF_ID, sha256(body)),
      (error) => error.code === 'content_too_large',
    );
  } finally {
    await server.close();
  }
});

test('content client verifies domain-prefixed document hashes', async () => {
  const document = {
    schemaVersion: 'work-model-request-v1',
    logicalKey: 'model:1',
    binding: { orgId: 'org_runtime', taskId: 't', runId: 'r' },
    parameters: { maxOutputTokens: 2048, temperatureMilli: 500, outputFormat: 'markdown' },
  };
  const pretty = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const expected = `sha256:${createHash('sha256')
    .update(`${document.schemaVersion}\n${canonical(document)}`)
    .digest('hex')}`;
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end(pretty);
  });
  try {
    const bytes = await client(server).get(REF_ID, expected, { digest: 'document' });
    assert.deepEqual(bytes, pretty);
    assert.equal(documentHash(pretty), expected);
    const permuted = Buffer.from(JSON.stringify(Object.fromEntries(
      Object.entries(document).reverse(),
    )));
    assert.equal(documentHash(permuted), expected);
  } finally {
    await server.close();
  }
});

const WRITE_REF = '33333333-3333-4333-8333-333333333333';
const SLOT = `checkpoint:${EXECUTION}:model:1:candidate`;
const CANDIDATE = Buffer.from(JSON.stringify({
  kind: 'checkpoint_candidate',
  schemaVersion: 'work-checkpoint-candidate-v1',
  logicalKey: 'model:1',
}));
const CANDIDATE_HASH = sha256(CANDIDATE);

function writeArgs(overrides = {}) {
  return { refId: WRITE_REF, logicalSlot: SLOT, hash: CANDIDATE_HASH, bytes: CANDIDATE, ...overrides };
}

function checkpointHandler(status, body) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

test('putCheckpoint writes one candidate with the binding headers', async () => {
  const body = { ref_id: WRITE_REF, content_hash: CANDIDATE_HASH, bytes: CANDIDATE.length };
  const server = await startServer((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    const committed = await client(server).putCheckpoint(writeArgs());
    assert.deepEqual(committed, {
      refId: WRITE_REF,
      hash: CANDIDATE_HASH,
      bytes: CANDIDATE.length,
    });

    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/internal/v1/checkpoints');
    assert.equal(request.body, CANDIDATE.toString('utf8'));
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['x-work-org'], ORG);
    assert.equal(request.headers['x-work-execution'], EXECUTION);
    assert.equal(request.headers['x-work-generation'], '3');
    assert.equal(request.headers['x-work-ref-id'], WRITE_REF);
    assert.equal(request.headers['x-work-logical-slot'], SLOT);
    assert.equal(request.headers['x-work-content-hash'], CANDIDATE_HASH);
    assert.equal(request.headers['content-type'], 'application/octet-stream');
  } finally {
    await server.close();
  }
});

for (const [status, code] of [
  [413, 'request_too_large'],
  [409, 'content_slot_conflict'],
  [401, 'capability_invalid'],
]) {
  test(`putCheckpoint surfaces ${status} as ${code} without retrying`, async () => {
    const server = await startServer(checkpointHandler(status, { code }));
    try {
      await assert.rejects(
        client(server).putCheckpoint(writeArgs()),
        (error) => {
          assert.equal(error.name, 'ContentClientError');
          assert.equal(error.code, code);
          assert.equal(error.status, status);
          assert.equal(error.message, code);
          return true;
        },
      );
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });
}

test('putCheckpoint refuses a local hash mismatch before sending', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(201);
    res.end();
  });
  try {
    await assert.rejects(
      client(server).putCheckpoint(writeArgs({ hash: `sha256:${'e'.repeat(64)}` })),
      (error) => error.code === 'content_hash_mismatch',
    );
    await assert.rejects(
      client(server).putCheckpoint(writeArgs({ refId: 'not-a-uuid' })),
      (error) => error.code === 'content_invalid_ref',
    );
    await assert.rejects(
      client(server).putCheckpoint(writeArgs({ logicalSlot: 'checkpoint:\n1' })),
      (error) => error.code === 'content_invalid_slot',
    );
    await assert.rejects(
      client(server, { maxBytes: 8 }).putCheckpoint(writeArgs()),
      (error) => error.code === 'content_too_large',
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('putCheckpoint refuses a response that does not match the declared binding', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ref_id: REF_ID,
      content_hash: CANDIDATE_HASH,
      bytes: CANDIDATE.length,
    }));
  });
  try {
    await assert.rejects(
      client(server).putCheckpoint(writeArgs()),
      (error) => error.code === 'content_invalid_response',
    );
  } finally {
    await server.close();
  }
});
