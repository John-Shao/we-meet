const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { TargetAuthorization } = require('../dist/remote-control/target-authorization.js');
const { sessionKey, canonical, AUDIENCE } = require('../dist/remote-control/authorization.js');
const { bindScreenSource, CaptureBindingStore } = require('../dist/remote-control/source-binding.js');

const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected asynchronous transition');
}
async function fixture(autoConsent = true) {
  const { SignJWT } = await import('jose');
  const controller = await sessionKey(), signing = await sessionKey();
  const trusted = { ...signing.publicKey, kid: 'coordinator-test', alg: 'ES256' };
  const keyRing = { v: 1, revision: 1, generation: 1, activeKid: trusted.kid, keys: [{ ...trusted, verifyUntil: null }] };
  let time = 1000;
  const now = () => time, seconds = () => 1800000000 + Math.floor(time / 1000);
  const context = { roomId: randomUUID(), roomSid: 'RM_test', participantSid: 'PA_target', identity: 'target-user', deviceSessionId: randomUUID(), authEpoch: 7 };
  const auth = { epoch: 7, signedIn: true, subject: context.identity, access: async () => 'test-only' };
  const captures = new CaptureBindingStore(now);
  const source = bindScreenSource({ id: 'screen:1:0', display_id: '1' }, [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 }],
    [{ left: 0, top: 0, width: 1920, height: 1080, deviceName: 'DISPLAY1', devicePath: 'test-monitor', rotation: 0, dpiX: 96, dpiY: 96 }], { toDip: rect => rect });
  captures.selected(source, context.authEpoch);
  const request = { v: 1, roomId: context.roomId, roomSid: context.roomSid,
    controllerUserId: randomUUID(), controllerIdentity: 'controller-user', controllerSid: 'PA_controller',
    targetUserId: randomUUID(), targetIdentity: context.identity, targetSid: context.participantSid,
    targetDeviceSessionId: context.deviceSessionId, controllerPublicKey: controller.publicKey,
    controllerName: '测试参会者', targetName: '被控参会者', scope: ['pointer', 'keyboard', 'text'], expiresAt: seconds() + 30 };
  const row = { id: randomUUID(), requestId: randomUUID(), requestDigest: createHash('sha256').update(canonical(request)).digest('hex'),
    request, binding: {}, state: 'PENDING', stateVersion: 1, epoch: 1, signingGeneration: 1, deadline: seconds() + 30, endReason: '', serverTime: seconds() };
  const helper = new EventEmitter(), nativeCalls = [];
  helper.showConsent = (...args) => {
    nativeCalls.push({ action: 'consent', args }); helper.lastConsent = args;
    if (autoConsent) queueMicrotask(() => helper.allow());
  };
  helper.allow = () => helper.emit('state', { event: 'consentAllowed', consentId: helper.lastConsent[0].replaceAll('-', '') });
  helper.closeGate = () => { nativeCalls.push({ action: 'close' }); queueMicrotask(() => helper.emit('state', { event: 'closed', reason: 'parent_stop', cleanup: 1 })); };
  helper.pause = () => { nativeCalls.push({ action: 'pause' }); queueMicrotask(() => helper.emit('state', { event: 'closed', reason: 'parent_pause', cleanup: 1 })); };
  helper.renew = ms => nativeCalls.push({ action: 'renew', ms });
  const calls = [], verified = [], proofs = new Map();
  const hooks = { challenge: () => {}, lease: () => {}, before: async () => {}, after: async () => {} };
  const cloud = { async request(action, roomId, options = {}) {
    assert.equal(roomId, context.roomId); const startedAt = now();
    calls.push({ action, options: clone(options) });
    await hooks.before(action, options);
    let data;
    if (action === 'capabilities') data = { enabled: true, roomSid: context.roomSid, signingKey: trusted };
    else if (action === 'session') data = clone(row);
    else if (action === 'challenge') {
      assert.equal(options.body.stateVersion, row.stateVersion);
      const purpose = options.body.purpose;
      const proof = { v: 1, audience: AUDIENCE, scope: ['pointer', 'keyboard', 'text'], purpose, challengeId: randomUUID(),
        requestId: row.requestId, sessionId: row.id, requestDigest: row.requestDigest, stateVersion: row.stateVersion,
        epoch: row.epoch + (purpose === 'resume' ? 1 : 0), expiresAt: Math.min(row.deadline, seconds() + 15),
        binding: purpose === 'prepare' ? { ...request, ...options.body.binding, sessionId: row.id } : clone(row.binding) };
      hooks.challenge(proof); proofs.set(proof.challengeId, clone(proof)); data = { proof };
    } else if (['prepare', 'approve', 'resume', 'lease'].includes(action)) {
      const proof = proofs.get(options.body.challengeId);
      assert.equal(proof.purpose, action);
      const key = await crypto.subtle.importKey('jwk', proof.binding.targetPublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(options.body.signature, 'base64url'), canonical(proof)), true);
      verified.push(action);
      row.stateVersion++;
      if (action === 'prepare') { row.binding = clone(proof.binding); row.state = 'PREPARING'; row.deadline = seconds() + 60; }
      else { if (action !== 'lease') row.state = 'ACTIVE'; if (action === 'resume') row.epoch++; row.deadline = seconds() + 15; }
      data = { session: clone(row) };
      if (action !== 'prepare') {
        const binding = { ...row.binding, epoch: row.epoch, state: row.state, stateVersion: row.stateVersion, policyDigest: 'a'.repeat(64), maxExpiresAt: 1800001801 };
        hooks.lease(binding);
        data.lease = await new SignJWT({ v: 1, binding }).setProtectedHeader({ alg: 'ES256', kid: trusted.kid, typ: 'JWT' })
          .setAudience(AUDIENCE).setIssuedAt(seconds()).setExpirationTime(seconds() + 15).sign(signing.privateKey);
      }
    } else if (action === 'pause') {
      if (options.body.stateVersion !== row.stateVersion) throw new Error('state_conflict');
      if (row.state !== 'PAUSED') { row.state = 'PAUSED'; row.stateVersion++; }
      data = clone(row);
    } else if (action === 'end' || action === 'reject') { row.state = action === 'end' ? 'ENDED' : 'REJECTED'; row.stateVersion++; data = clone(row); }
    else throw new Error('unexpected_test_action');
    data.keyRing = clone(keyRing);
    await hooks.after(action, data);
    return { data: { ...data, serverTime: seconds() }, serverTime: seconds(), startedAt, receivedAt: now() };
  } };
  const target = new TargetAuthorization({ context, auth, captures, helper, cloud, now });
  return { target, context, auth, captures, source, helper, nativeCalls, row, calls, verified, hooks, signing, trusted, keyRing, seconds,
    advance: ms => { time += ms; }, tick: () => target.tick(), start: () => target.start(row.id, source.shareInstanceId, 'TR_screen') };
}

test('prepare, native confirmation and exact signed lease precede an input grant; HTTP ACTIVE never arms', async t => {
  const f = await fixture(false); t.after(() => f.target.dispose());
  const starting = f.start(); await until(() => f.helper.lastConsent);
  assert.deepEqual(f.verified, ['prepare']);
  assert.equal(f.captures.active(7).trackSid, 'TR_screen');
  assert.throws(() => f.target.inputGrant(), /local_consent_required/);
  f.helper.allow(); await starting;
  assert.deepEqual(f.verified, ['prepare', 'approve']);
  assert.equal(f.target.status().phase, 'active');
  assert.equal(f.target.status().inputOpen, false);
  const grant = f.target.inputGrant(); assert.equal(grant.remainingMs, 14000);
  assert.equal(grant.binding.targetDeviceSessionId, f.context.deviceSessionId);
  assert.equal(f.nativeCalls.filter(c => c.action !== 'consent').length, 0);
  grant.binding.trackSid = 'TR_mutated';
  assert.equal(f.target.inputGrant().binding.trackSid, 'TR_screen');
});

test('B renews across planned key rotation without a second consent, then closes on key revocation', async t => {
  const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
  const old = { ...f.trusted, verifyUntil: f.seconds() + 15 };
  const next = await sessionKey(); Object.assign(f.signing, next);
  Object.assign(f.trusted, next.publicKey, { kid: 'rotated-key' });
  Object.assign(f.keyRing, { revision: 2, activeKid: 'rotated-key', keys: [old, { ...f.trusted, verifyUntil: null }] });
  f.advance(5000); f.tick(); await until(() => f.verified.includes('lease'));
  await until(() => !f.target.busy);
  assert.equal(f.target.status().phase, 'active');
  assert.equal(f.nativeCalls.filter(call => call.action === 'consent').length, 1);
  assert.equal(f.target.inputGrant().epoch, 1);
  f.keyRing.generation = 2; f.keyRing.revision++;
  f.advance(5000); f.tick(); await until(() => f.target.status().phase === 'ended');
  assert.throws(() => f.target.inputGrant());
  assert.ok(f.nativeCalls.some(call => call.action === 'close'));
});

test('tampered proof purpose, version, key, scope or extra field is never signed', async t => {
  for (const mutate of [p => p.purpose = 'lease', p => p.stateVersion++, p => p.binding.targetPublicKey.x = 'a'.repeat(43),
    p => p.scope.push('clipboard'), p => p.extra = true, p => p.epoch++, p => p.binding.trackSid = 'TR_other']) {
    const f = await fixture(); t.after(() => f.target.dispose());
    f.hooks.challenge = proof => { if (proof.purpose === 'approve') mutate(proof); };
    await assert.rejects(f.start(), /challenge_binding_mismatch/);
    assert.deepEqual(f.verified, ['prepare']); assert.equal(f.target.status().phase, 'ended');
  }
});

test('a correctly signed server lease with changed local key, source or version cannot grant input', async t => {
  for (const mutate of [b => b.targetPublicKey = { ...b.targetPublicKey, x: 'a'.repeat(43) }, b => b.shareInstanceId = randomUUID(), b => b.stateVersion++, b => b.epoch++]) {
    const f = await fixture(); t.after(() => f.target.dispose()); f.hooks.lease = mutate;
    await assert.rejects(f.start(), /lease_binding_mismatch|state_conflict/);
    assert.equal(f.target.status().phase, 'ended'); assert.throws(() => f.target.inputGrant());
  }
});

test('stop while approval is in flight closes immediately; late successful HTTP response cannot revive', async t => {
  const f = await fixture(); t.after(() => f.target.dispose());
  const gate = deferred(); let committed = false;
  f.hooks.after = async action => { if (action === 'approve') { committed = true; await gate.promise; } };
  const starting = f.start(); const rejected = assert.rejects(starting, /authorization_cancelled/);
  await until(() => committed); f.target.stop();
  assert.equal(f.nativeCalls.at(-1).action, 'close'); assert.equal(f.target.status().phase, 'ended');
  gate.resolve(); await rejected; assert.throws(() => f.target.inputGrant());
});

test('login change or capture replacement while native dialog is open cancels without approval', async t => {
  for (const change of [f => f.auth.epoch++, f => f.auth.subject = 'another-user', f => f.captures.invalidate()]) {
    const f = await fixture(false); t.after(() => f.target.dispose());
    const starting = f.start(); const rejected = assert.rejects(starting, /remote_account_changed|capture_binding_mismatch/);
    await until(() => f.helper.lastConsent); change(f); f.helper.allow(); await rejected;
    assert.deepEqual(f.verified, ['prepare']); assert.equal(f.target.status().phase, 'ended');
  }
});

test('expired native confirmation and a cancelled server request cannot be approved late', async t => {
  const f = await fixture(false); t.after(() => f.target.dispose());
  const starting = f.start(); const rejected = assert.rejects(starting, /authorization_expired/);
  await until(() => f.helper.lastConsent); f.advance(60000); f.helper.allow(); await rejected;
  assert.deepEqual(f.verified, ['prepare']);
  const cancelled = await fixture(false); t.after(() => cancelled.target.dispose());
  const pending = cancelled.start(); const failure = assert.rejects(pending, /authorization_changed/);
  await until(() => cancelled.helper.lastConsent);
  cancelled.row.state = 'CANCELLED'; cancelled.row.stateVersion++; cancelled.advance(2000); cancelled.tick();
  await failure; cancelled.helper.allow(); assert.deepEqual(cancelled.verified, ['prepare']);
});

test('local takeover closes before HTTP, survives an in-flight renewal, and only native action resumes a new epoch', async t => {
  const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
  f.helper.emit('state', { event: 'armed' }); assert.equal(f.target.status().inputOpen, true);
  const gate = deferred(); let committed = false;
  f.hooks.after = async action => { if (action === 'lease' && !committed) { committed = true; await gate.promise; } };
  f.advance(5000); f.tick(); await until(() => committed);
  f.helper.emit('state', { event: 'closed', reason: 'local_takeover', cleanup: 1 });
  assert.equal(f.target.status().inputOpen, false); assert.throws(() => f.target.inputGrant());
  await until(() => f.target.status().phase === 'paused'); gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.nativeCalls.filter(c => c.action === 'renew').length, 0);
  assert.equal(f.target.status().phase, 'paused'); assert.equal(f.target.status().epoch, 1);
  f.helper.emit('state', { event: 'resumeRequested' });
  await until(() => f.target.status().phase === 'active');
  assert.equal(f.target.status().epoch, 2); assert.equal(f.target.status().inputOpen, false);
  assert.equal(f.nativeCalls.filter(c => c.action === 'consent').length, 2);
  assert.equal(f.target.inputGrant().epoch, 2);
});

test('explicit pause uses native close-and-release before waiting for cloud; paused lease does not resume', async t => {
  const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
  f.target.on('state', state => {
    if (state.phase === 'pausing') assert.equal(f.nativeCalls.at(-1).action, 'pause');
    if (state.phase === 'ended') assert.equal(f.nativeCalls.at(-1).action, 'close');
  });
  f.target.pause(); assert.equal(f.nativeCalls.at(-1).action, 'pause');
  await until(() => f.target.status().phase === 'paused');
  f.tick(); await until(() => f.verified.includes('lease'));
  assert.equal(f.row.state, 'PAUSED'); assert.equal(f.target.status().epoch, 1);
  assert.throws(() => f.target.inputGrant(), /local_consent_required/);
});

test('negative or absent cleanup confirmation blocks the coordinator permanently', async t => {
  for (const cleanup of [-2, -1, 0, undefined]) {
    const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
    f.helper.emit('state', { event: 'closed', reason: 'local_takeover', cleanup });
    assert.equal(f.target.status().phase, 'blocked'); assert.equal(f.target.status().cleanupBlocked, true);
    f.helper.emit('state', { event: 'resumeRequested' }); assert.throws(() => f.target.inputGrant());
  }
});

test('server pause cannot offer resume before native release acknowledgement; missing acknowledgement blocks', async t => {
  for (const acknowledge of [true, false]) {
    const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
    f.helper.pause = () => {}; // Delay the native reply, not the HTTP request.
    f.target.pause(); await until(() => f.row.state === 'PAUSED');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.target.status().phase, 'pausing');
    f.helper.emit('state', { event: 'closed', reason: 'local_takeover', cleanup: 1 });
    f.helper.emit('state', { event: 'resumeRequested' });
    assert.equal(f.nativeCalls.filter(c => c.action === 'consent').length, 1);
    if (acknowledge) {
      f.helper.emit('state', { event: 'closed', reason: 'parent_pause', cleanup: 1 });
      assert.equal(f.target.status().phase, 'paused');
    } else {
      f.advance(1500); f.tick(); assert.equal(f.target.status().phase, 'blocked');
    }
  }
});

test('active renewals consume a fresh proof and cannot outlive the monotonic deadline', async t => {
  const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
  f.helper.emit('state', { event: 'armed' }); f.advance(5000); f.tick();
  await until(() => f.nativeCalls.some(c => c.action === 'renew'));
  assert.equal(f.nativeCalls.at(-1).ms, 14000);
  assert.equal(f.target.status().stateVersion, 4);
  f.advance(15000); f.tick(); assert.equal(f.target.status().phase, 'ended');
  assert.equal(f.nativeCalls.at(-1).action, 'close');
});

test('approval network delay consumes the lease instead of starting another fifteen seconds on receipt', async t => {
  const f = await fixture(); t.after(() => f.target.dispose());
  f.hooks.after = action => { if (action === 'approve') f.advance(14000); };
  await assert.rejects(f.start(), /authorization_expired|lease_expired/);
  assert.equal(f.target.status().phase, 'ended'); assert.throws(() => f.target.inputGrant());
});

test('a native consent event for another dialog does not approve this request', async t => {
  const f = await fixture(false); t.after(() => f.target.dispose());
  const starting = f.start(); const rejected = assert.rejects(starting, /local_stop/);
  await until(() => f.helper.lastConsent);
  f.helper.emit('state', { event: 'consentAllowed', consentId: randomUUID().replaceAll('-', '') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.verified, ['prepare']); f.target.stop(); await rejected;
});

test('request digest, local identity and device are checked before any prepare signature', async t => {
  for (const mutate of [r => r.requestDigest = '0'.repeat(64), r => r.request.targetDeviceSessionId = randomUUID(),
    r => r.request.targetIdentity = 'another-user', r => r.request.scope.push('clipboard')]) {
    const f = await fixture(); t.after(() => f.target.dispose()); mutate(f.row);
    await assert.rejects(f.start(), /request_binding_mismatch/);
    assert.deepEqual(f.verified, []); assert.equal(f.nativeCalls.some(c => c.action === 'consent'), false);
  }
});

test('native resume does not cancel an in-flight signed health response on the same session key', async t => {
  const f = await fixture(); t.after(() => f.target.dispose()); await f.start();
  f.target.pause(); await until(() => f.target.status().phase === 'paused');
  const response = f.target.targetSignal('HEARTBEAT_ACK', { heartbeatSeq: 1 }, null, 1);
  f.helper.emit('state', { event: 'resumeRequested' });
  await assert.doesNotReject(response); await until(() => f.target.status().phase === 'active');
  assert.equal(f.target.status().epoch, 2);
});
