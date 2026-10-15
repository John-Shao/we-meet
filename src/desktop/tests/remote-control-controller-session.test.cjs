const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { ControllerSession } = require('../dist/remote-control/controller-session.js');
const { sessionKey, canonical, AUDIENCE } = require('../dist/remote-control/authorization.js');

const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 150 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), 'Expected controller transition');
}
async function fixture(t) {
  const { SignJWT } = await import('jose');
  const signing = await sessionKey(), targetKey = await sessionKey();
  const signingKey = { ...signing.publicKey, alg: 'ES256', kid: 'controller-session-test' };
  const keyRing = { v: 1, revision: 1, generation: 1, activeKid: signingKey.kid, keys: [{ ...signingKey, verifyUntil: null }] };
  const context = { roomId: randomUUID(), roomSid: 'RM_test', identity: 'controller', participantSid: 'PA_a', userId: randomUUID() };
  const target = { identity: 'target', participantSid: 'PA_b', userId: randomUUID(), name: 'Target' };
  let time = 1000, current = true, row;
  const seconds = () => 1800000000 + Math.floor(time / 1000);
  const calls = [], sent = [], states = [];
  const hooks = { reply: async () => {}, request: () => {}, lease: () => {} };
  const api = async (action, options = {}) => {
    calls.push({ action, options }); const startedAt = time;
    if (action === 'requests') {
      const r = { v: 1, roomId: context.roomId, roomSid: context.roomSid, controllerUserId: context.userId,
        controllerIdentity: context.identity, controllerSid: context.participantSid, targetUserId: target.userId,
        targetIdentity: target.identity, targetSid: target.participantSid, targetDeviceSessionId: randomUUID(),
        controllerPublicKey: options.body.controllerPublicKey, controllerName: 'Controller', targetName: target.name,
        scope: ['pointer', 'keyboard', 'text'], expiresAt: seconds() + 30 };
      hooks.request(r);
      row = { id: randomUUID(), requestId: options.body.requestId, request: r, requestDigest: createHash('sha256').update(canonical(r)).digest('hex'),
        binding: {}, state: 'PENDING', stateVersion: 1, epoch: 1, signingGeneration: 1, deadline: seconds() + 30 };
    }
    const data = { ...clone(row), keyRing: clone(keyRing) }; await hooks.reply(action, data);
    return { data, serverTime: seconds(), startedAt, receivedAt: time };
  };
  const session = new ControllerSession({ context, target, keyRing, request: api, send: async m => { sent.push(m); },
    isCurrent: () => current, onState: s => states.push(s), now: () => time, automaticTimer: false });
  t.after(() => session.stop());
  const prepare = () => {
    row.state = 'PREPARING'; row.stateVersion++; row.deadline = seconds() + 60;
    row.binding = { ...row.request, targetPublicKey: targetKey.publicKey, sessionId: row.id, shareInstanceId: randomUUID(), trackSid: 'TR_screen', displayBindingHash: 'a'.repeat(64) };
  };
  const lease = async (state = 'ACTIVE') => {
    row.state = state; row.stateVersion++; row.deadline = seconds() + 15;
    const binding = { ...row.binding, epoch: row.epoch, state, stateVersion: row.stateVersion, maxExpiresAt: seconds() + 1800, policyDigest: 'b'.repeat(64) };
    hooks.lease(binding);
    row.lease = await new SignJWT({ v: 1, binding }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: signingKey.kid })
      .setAudience(AUDIENCE).setIssuedAt(seconds()).setExpirationTime(seconds() + 15).sign(signing.privateKey);
  };
  const poll = async () => { time += 500; session.wake(); session.tick(); await until(() => !session.polling); };
  return { session, context, target, signingKey, signing, keyRing, seconds, calls, sent, states, hooks, prepare, lease, poll,
    row: () => row, advance: ms => { time += ms; }, setCurrent: value => { current = value; } };
}

test('A creates a nonexportable fresh session key, binds the exact peer/track, and a signed ACTIVE never auto-arms', async t => {
  const f = await fixture(t); await f.session.start();
  assert.equal(f.session.status().phase, 'pending');
  await assert.rejects(crypto.subtle.exportKey('jwk', f.session.key.privateKey));
  assert.equal(f.calls[0].options.body.targetSid, 'PA_b');
  f.prepare(); await f.poll(); assert.equal(f.session.status().trackSid, 'TR_screen');
  await f.lease(); await f.poll();
  assert.equal(f.session.status().phase, 'active'); assert.equal(f.session.status().input.phase, 'waiting');
  assert.equal(f.sent.length, 0); assert.throws(() => f.session.capture(), /capture_unavailable/);
});

test('A accepts a planned signer switch but a generation change ends the controller', async t => {
  const f = await fixture(t); await f.session.start(); f.prepare(); await f.poll();
  await f.lease(); await f.poll();
  const old = { ...f.signingKey, verifyUntil: f.seconds() + 15 };
  const next = await sessionKey(); Object.assign(f.signing, next);
  Object.assign(f.signingKey, next.publicKey, { kid: 'rotated-key' });
  Object.assign(f.keyRing, { revision: 2, activeKid: 'rotated-key', keys: [old, { ...f.signingKey, verifyUntil: null }] });
  await f.lease(); await f.poll();
  assert.equal(f.session.status().phase, 'active');
  f.keyRing.generation = 2; f.keyRing.revision++;
  await f.poll();
  assert.equal(f.session.status().phase, 'ended');
  assert.equal(f.session.status().reason, 'signing_generation_revoked');
  assert.equal(f.session.input({ kind: 'move', x: 0, y: 0 }), false);
});

test('wrong request peer or own key is rejected even if its server digest is self-consistent', async t => {
  for (const mutate of [r => r.targetSid = 'PA_other', r => r.controllerUserId = randomUUID(),
    r => r.controllerPublicKey = { ...r.controllerPublicKey, x: 'a'.repeat(43) }]) {
    const f = await fixture(t); f.hooks.request = mutate; await f.session.start();
    assert.equal(f.session.status().phase, 'ended'); assert.equal(f.session.status().reason, 'session_binding_mismatch');
    assert.equal(f.sent.length, 0);
  }
});

test('digest tampering, unsigned ACTIVE and a signed lease for another track cannot open input', async t => {
  const digest = await fixture(t); digest.hooks.reply = async (action, data) => { if (action === 'requests') data.requestDigest = '0'.repeat(64); };
  await digest.session.start(); assert.equal(digest.session.status().reason, 'request_digest_mismatch');
  for (const badLease of [false, true]) {
    const f = await fixture(t); await f.session.start(); f.prepare(); await f.poll();
    f.hooks.lease = b => { if (badLease) b.trackSid = 'TR_other'; }; await f.lease();
    if (!badLease) delete f.row().lease;
    await f.poll(); assert.equal(f.session.status().phase, 'ended'); assert.equal(f.sent.length, 0);
    assert.equal(f.session.status().reason, badLease ? 'lease_binding_mismatch' : 'invalid_lease');
  }
});

test('paused HTTP closes immediately without extending the last verified lease', async t => {
  const f = await fixture(t); await f.session.start(); f.prepare(); await f.poll(); await f.lease(); await f.poll();
  const deadline = f.session.deadline;
  f.row().state = 'PAUSED'; f.row().stateVersion++; delete f.row().lease;
  await f.poll(); assert.equal(f.session.status().input.phase, 'paused'); assert.equal(f.session.deadline, deadline);
  f.advance(14000); f.session.tick(); assert.equal(f.session.status().reason, 'authorization_expired');
});

test('cancel before POST receipt revokes that exact late session and cannot revive after account switch', async t => {
  for (const stillCurrent of [true, false]) {
    const f = await fixture(t), held = deferred();
    f.hooks.reply = async action => { if (action === 'requests') await held.promise; };
    const starting = f.session.start(); await until(() => f.row()); f.session.stop(); f.setCurrent(stillCurrent);
    held.resolve(); await starting;
    assert.equal(f.session.status().phase, 'ended'); assert.equal(f.session.key, undefined);
    const ends = f.calls.filter(c => c.action === 'end'); assert.equal(ends.length, stillCurrent ? 1 : 0);
    if (stillCurrent) assert.equal(ends[0].options.sessionId, f.row().id);
  }
});

test('an old successful poll after leaving the meeting cannot recreate transport or send input', async t => {
  const f = await fixture(t); await f.session.start(); f.prepare(); await f.lease();
  const held = deferred(); f.hooks.reply = async action => { if (action === 'session') await held.promise; };
  f.advance(1000); f.session.tick(); await until(() => f.session.polling);
  f.setCurrent(false); f.session.tick(); held.resolve(); await until(() => !f.session.polling);
  assert.equal(f.session.status().phase, 'ended'); assert.equal(f.session.transport, undefined); assert.equal(f.sent.length, 0);
});

test('round-trip time is deducted from a signed lease and immutable capture binding cannot change', async t => {
  const f = await fixture(t); await f.session.start(); f.prepare(); await f.poll(); await f.lease();
  f.hooks.reply = async action => { if (action === 'session') f.advance(15000); };
  await f.poll(); assert.equal(f.session.status().phase, 'ended');
  const g = await fixture(t); await g.session.start(); g.prepare(); await g.poll();
  g.row().binding.trackSid = 'TR_replaced'; await g.lease(); await g.poll();
  assert.equal(g.session.status().reason, 'session_binding_mismatch');
});
