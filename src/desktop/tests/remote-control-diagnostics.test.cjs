const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRemoteDiagnostics } = require('../dist/remote-control/diagnostics.js');

test('diagnostics retain native lifecycle evidence without credentials, identifiers or input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sink = createRemoteDiagnostics(root);
  sink.record('native', { event: 'consentAllowed', consentId: 'private-id', nonce: 'private-nonce', token: 'private-token', text: 'private-input' });
  sink.record('native', { event: 'inputAck', seq: 1, text: 'private-input' });
  sink.record('failure', { reason: 'privatecredential', sessionId: 'private-session', error: 'private-error' });
  sink.record('native', { event: 'closed', reason: 'desktop_observation_lost', cleanup: -2, wasActive: false });
  sink.record('native', { event: 'terminated', cleanup: -2, exitCode: 3 });
  sink.record('state', { phase: 'blocked', cleanupBlocked: true, sessionId: 'private-session' });
  sink.record('state', { phase: 'blocked', cleanupBlocked: true, sessionId: 'another-private-session' });
  await sink.flush();
  const text = await fs.readFile(path.join(root, 'remote-control.jsonl'), 'utf8');
  assert.doesNotMatch(text, /private|inputAck|nonce|token|consentId|sessionId/);
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].event, 'consentAllowed');
  assert.equal(rows[1].reason, 'unknown');
  assert.equal(rows[2].reason, 'desktop_observation_lost');
  assert.equal(rows[2].cleanup, -2);
  assert.equal(rows[3].exitCode, 3);
  assert.equal(rows[4].phase, 'blocked');
});

test('diagnostics rotate within the storage cap and tolerate unavailable storage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sink = createRemoteDiagnostics(root);
  for (let batch = 0; batch < 20; ++batch) {
    for (let index = 0; index < 100; ++index)
      sink.record('native', { event: 'closed', reason: 'desktop_observation_lost', cleanup: -2, wasActive: false });
    await sink.flush();
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ['remote-control.jsonl', 'remote-control.jsonl.previous']);
  for (const name of await fs.readdir(root)) assert.ok((await fs.stat(path.join(root, name))).size <= 128 * 1024);
  const bad = createRemoteDiagnostics(path.join(root, 'remote-control.jsonl', 'not-a-directory'));
  bad.record('state', { phase: 'preparing' });
  await assert.doesNotReject(bad.flush());
});
