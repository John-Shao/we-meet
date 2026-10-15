const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { sessionKey, publicKeyBytes } = require('../dist/remote-control/authorization.js');
const { signalPayload, signSignal, verifySignal, importSignalKey, SignalSequence, INPUT_TOPIC, SIGNAL_TOPIC } = require('../dist/remote-control/signals.js');
const { signInput, Kind } = require('../dist/remote-control/wire.js');
const { TargetTransport } = require('../dist/remote-control/target-transport.js');

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); ++i) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected asynchronous transport transition');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const a = await sessionKey(), b = await sessionKey();
  const binding = { roomId: randomUUID(), roomSid: 'RM_current', sessionId: randomUUID(), shareInstanceId: randomUUID(), trackSid: 'TR_current',
    controllerIdentity: 'controller', controllerSid: 'PA_controller', targetIdentity: 'target', targetSid: 'PA_target', controllerPublicKey: a.publicKey };
  let now = 1000, epoch = 1, phase = 'active', incoming = 0;
  const helper = new EventEmitter(), auth = new EventEmitter();
  const calls = { arms: [], inputs: [], suspends: 0, stops: [], pauses: 0, blocks: 0 };
  const raw = [], delivered = [];
  const hooks = { sign: async () => {}, send: async () => {}, autoArm: true, autoRelease: true };
  auth.status = () => ({ phase });
  auth.transportState = () => {
    if (['ended', 'blocked'].includes(phase)) throw new Error('authorization_cancelled');
    return { binding, epoch, state: phase === 'active' ? 'ACTIVE' : 'PAUSED' };
  };
  auth.inputGrant = () => {
    if (phase !== 'active') throw new Error('local_consent_required');
    return { binding, epoch, remainingMs: 14000, controllerPublicKey: publicKeyBytes(a.publicKey), source: { native: { left: 0, top: 0, width: 1920, height: 1080 } } };
  };
  auth.targetSignal = async (type, body, generation, seq) => {
    const payload = signalPayload(binding, 'target', epoch, generation, seq, type, body);
    await hooks.sign(type); return signSignal(payload, b.privateKey);
  };
  auth.stop = reason => { if (phase === 'ended' || phase === 'blocked') return; calls.stops.push(reason); phase = 'ended'; auth.emit('state'); };
  auth.block = reason => { calls.blocks++; auth.stop(reason); };
  auth.pause = () => { calls.pauses++; phase = 'paused'; auth.emit('state'); };
  helper.arm = (...args) => {
    calls.arms.push(args);
    if (hooks.autoArm) queueMicrotask(() => {
      helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 });
      helper.emit('state', { event: 'armed' });
    });
  };
  helper.input = packet => calls.inputs.push(packet);
  helper.suspendCapture = () => {
    calls.suspends++;
    if (hooks.autoRelease) queueMicrotask(() => helper.emit('state', { event: 'closed', reason: 'capture_suspended', cleanup: 1 }));
  };
  const verifyKey = await importSignalKey(b.publicKey);
  const peer = new TargetTransport(auth, helper, async message => {
    raw.push(message); await hooks.send(message);
    delivered.push(await verifySignal(message.payload, verifyKey, binding, 'target'));
  }, () => now);
  await peer.start(); await until(() => delivered.length === 1);
  const latest = type => delivered.filter(message => message.type === type).at(-1);
  const controllerPacket = async (type, extra = {}, generation = null, change = {}) => {
    const body = { challenge: latest('CHALLENGE').body.challenge,
      ...(type === 'END' ? {} : { videoReady: true, captureReady: type !== 'INPUT_SUSPEND' }), ...extra };
    return signSignal({ ...signalPayload(binding, 'controller', epoch, generation, ++incoming, type, body), ...change }, a.privateKey);
  };
  const receive = (payload, metadata = {}) => peer.receive({ topic: SIGNAL_TOPIC, participantIdentity: binding.controllerIdentity, participantSid: binding.controllerSid, payload, ...metadata });
  const signal = async (...args) => receive(await controllerPacket(...args));
  const ready = async () => { await signal('HELLO'); await until(() => latest('READY')); return latest('READY'); };
  return { peer, auth, helper, calls, hooks, delivered, raw, binding, a, b, latest, controllerPacket, receive, signal, ready,
    advance: ms => { now += ms; }, tick: () => peer.tick(),
    resumeBusiness: () => { epoch++; incoming = 0; phase = 'active'; auth.emit('state'); } };
}

test('signed signals bind both connections, full capture, type, schema and signature; sequence gaps fail', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose());
  const key = await importSignalKey(f.a.publicKey), packet = await f.controllerPacket('HELLO');
  assert.equal((await verifySignal(packet, key, f.binding, 'controller')).seq, 1);
  for (const change of [{ targetIdentity: 'other' }, { roomSid: 'RM_other' }, { trackSid: 'TR_other' }]) {
    await assert.rejects(verifySignal(packet, key, { ...f.binding, ...change }, 'controller'), /binding/);
  }
  const decoded = JSON.parse(new TextDecoder().decode(packet)); decoded.body.captureReady = false;
  await assert.rejects(verifySignal(new TextEncoder().encode(JSON.stringify(decoded)), key, f.binding, 'controller'));
  decoded.body.captureReady = true; decoded.extra = true;
  await assert.rejects(verifySignal(new TextEncoder().encode(JSON.stringify(decoded)), key, f.binding, 'controller'), /invalid_signal/);
  const sequence = new SignalSequence(); assert.equal(sequence.accept(4, true), true);
  assert.equal(sequence.accept(4), false); assert.equal(sequence.accept(5), true); assert.throws(() => sequence.accept(7), /signal_gap/);
});

test('only signed video/focus HELLO arms, READY follows native challenge/armed, and destination stays unique', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); f.hooks.autoArm = false;
  assert.equal(f.calls.arms.length, 0);
  await f.signal('HEARTBEAT', { captureReady: false }); assert.equal(f.calls.arms.length, 0);
  await f.signal('HELLO'); assert.equal(f.calls.arms.length, 1); assert.equal(f.latest('READY'), undefined);
  f.helper.emit('state', { event: 'challenge', nonce: '22'.repeat(16), ttlMs: 3000 });
  f.helper.emit('state', { event: 'armed' }); await until(() => f.latest('READY'));
  const ready = f.latest('READY'); assert.equal(ready.inputGeneration, f.calls.arms[0][0].inputGeneration);
  assert.equal(ready.body.inputChallenge, '22'.repeat(16));
  assert.ok(f.raw.every(message => message.topic === SIGNAL_TOPIC && message.destinationIdentity === 'controller'));
  await f.signal('HEARTBEAT'); await until(() => f.latest('HEARTBEAT_ACK').body.heartbeatSeq === 3);
  assert.equal(f.latest('INPUT_ACK'), undefined); // A health ACK is never an execution ACK.
  f.helper.emit('state', { event: 'inputAck', seq: 4 }); await until(() => f.latest('INPUT_ACK'));
  assert.equal(f.latest('INPUT_ACK').body.lastAppliedInputSeq, 4);
});

test('focus suspension waits for release ACK; fresh resume uses another generation and drops old input', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); const first = await f.ready(); f.hooks.autoRelease = false;
  await f.signal('INPUT_SUSPEND', {}, first.inputGeneration);
  assert.equal(f.calls.suspends, 1); assert.equal(f.latest('SUSPEND_ACK'), undefined);
  await f.signal('INPUT_RESUME', { resumeChallenge: '33'.repeat(16) }); assert.equal(f.calls.arms.length, 1);
  // An in-flight heartbeat may still refer to the last pre-suspend challenge.
  await f.signal('HEARTBEAT', { captureReady: false }); assert.equal(f.calls.stops.length, 0);
  f.helper.emit('state', { event: 'closed', reason: 'capture_suspended', cleanup: 1 }); await until(() => f.latest('SUSPEND_ACK'));
  const ack = f.latest('SUSPEND_ACK'); assert.equal(ack.inputGeneration, null);
  await f.signal('INPUT_RESUME', { resumeChallenge: ack.body.resumeChallenge });
  await until(() => f.delivered.filter(m => m.type === 'READY').length === 2);
  const second = f.latest('READY'); assert.notEqual(first.inputGeneration, second.inputGeneration);
  const packet = generation => signInput({ sessionId: f.binding.sessionId, shareInstanceId: f.binding.shareInstanceId, epoch: 1,
    inputGeneration: generation, seq: 1, kind: Kind.Heartbeat, challenge: '11'.repeat(16) }, f.a.privateKey);
  await f.receive(await packet(first.inputGeneration), { topic: INPUT_TOPIC }); assert.equal(f.calls.inputs.length, 0);
  await f.receive(await packet(second.inputGeneration), { topic: INPUT_TOPIC }); assert.equal(f.calls.inputs.length, 1);
});

test('resume challenges are one-use, expire on B monotonic time, and cannot revive business PAUSED', async t => {
  for (const operation of ['reuse', 'expire', 'paused']) {
    const f = await fixture(); t.after(() => f.peer.dispose()); await f.ready();
    await f.signal('INPUT_SUSPEND'); await until(() => f.latest('SUSPEND_ACK'));
    const nonce = f.latest('SUSPEND_ACK').body.resumeChallenge;
    if (operation === 'paused') {
      f.auth.pause(); await f.signal('INPUT_RESUME', { resumeChallenge: nonce }); assert.equal(f.calls.arms.length, 1);
      f.resumeBusiness(); await until(() => f.latest('CHALLENGE').epoch === 2);
      await f.signal('HELLO'); await until(() => f.latest('READY').epoch === 2); assert.equal(f.calls.arms.length, 2);
    } else {
      if (operation === 'reuse') {
        await f.signal('INPUT_RESUME', { resumeChallenge: nonce }); await until(() => f.calls.arms.length === 2);
        await f.signal('INPUT_SUSPEND'); await until(() => f.delivered.filter(m => m.type === 'SUSPEND_ACK').length === 2);
      } else {
        f.advance(2000); await f.signal('HEARTBEAT', { captureReady: false }); await f.peer.outbound; f.advance(1001);
        // Issue a fresh health challenge while retaining the expired resume token in A's request.
        const previousChallenge = f.latest('CHALLENGE').body.challenge;
        f.peer.issueChallenge(); await until(() => f.latest('CHALLENGE').body.challenge !== previousChallenge);
      }
      await f.signal('INPUT_RESUME', { resumeChallenge: nonce }); assert.equal(f.calls.stops.at(-1), 'expired_resume_challenge');
    }
  }
});

test('wrong participant metadata is ignored; authenticated signal gaps and forged signatures close', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose());
  const valid = await f.controllerPacket('HELLO');
  await f.receive(valid, { participantIdentity: 'third-participant', participantSid: 'PA_third' }); assert.equal(f.calls.arms.length, 0);
  await f.receive(valid); await until(() => f.latest('READY'));
  const gap = await f.controllerPacket('HEARTBEAT', {}, null, { seq: 3 }); await f.receive(gap);
  assert.equal(f.calls.stops.at(-1), 'signal_gap');
  const bad = await fixture(); t.after(() => bad.peer.dispose());
  const decoded = JSON.parse(new TextDecoder().decode(await bad.controllerPacket('HELLO')));
  decoded.signature = 'A'.repeat(86); await bad.receive(new TextEncoder().encode(JSON.stringify(decoded)));
  assert.equal(bad.calls.arms.length, 0); assert.equal(bad.calls.stops.length, 1);
});

test('missing native release blocks; missing controller heartbeat ends even without input', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); await f.ready(); f.hooks.autoRelease = false;
  await f.signal('INPUT_SUSPEND'); f.advance(1500); f.tick(); assert.equal(f.calls.blocks, 1);
  const idle = await fixture(); t.after(() => idle.peer.dispose()); idle.advance(3000); idle.tick();
  assert.equal(idle.calls.stops.at(-1), 'controller_timeout');
});

test('suspend during Arm prevents READY and a signed-but-not-emitted READY never leaves a sequence gap', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); f.hooks.autoArm = false;
  await f.signal('HELLO'); await f.signal('INPUT_SUSPEND');
  f.helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 }); f.helper.emit('state', { event: 'armed' });
  await until(() => f.latest('SUSPEND_ACK')); assert.equal(f.latest('READY'), undefined);
  const racing = await fixture(); t.after(() => racing.peer.dispose()); const gate = deferred(); let signing = false;
  racing.hooks.sign = async type => { if (type === 'READY') { signing = true; await gate.promise; } };
  await racing.signal('HELLO'); await until(() => signing); racing.auth.pause(); gate.resolve();
  await until(() => racing.latest('STATE')); assert.equal(racing.latest('READY'), undefined);
  const seq = new SignalSequence(); racing.delivered.forEach(message => assert.equal(seq.accept(message.seq), true));
});

test('late local queue cannot release a burst of signed input and stopped transport never forwards', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); await f.ready();
  const gate = deferred(); f.peer.inbound = gate.promise;
  const packet = await f.controllerPacket('HEARTBEAT');
  const waiting = f.receive(packet); f.advance(251); gate.resolve(); await waiting;
  assert.equal(f.calls.stops.at(-1), 'remote_queue_expired');
  const previous = f.calls.inputs.length;
  await f.receive(new Uint8Array(704), { topic: INPUT_TOPIC }); assert.equal(f.calls.inputs.length, previous);
});

test('a never-completing publish is stopped by the independent queue watchdog', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); const gate = deferred(); let sending = false;
  f.hooks.send = async () => { sending = true; await gate.promise; };
  await f.signal('HELLO'); await until(() => sending);
  f.advance(251); f.tick(); assert.equal(f.calls.stops.at(-1), 'remote_queue_expired'); gate.resolve();
});

test('video loss causes a B-owned pause that a later ready heartbeat cannot clear', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); await f.ready();
  await f.signal('HEARTBEAT', { videoReady: false }); assert.equal(f.calls.pauses, 1);
  await f.signal('HEARTBEAT'); await f.signal('HELLO'); assert.equal(f.calls.arms.length, 1);
  await until(() => f.latest('STATE')); assert.equal(f.latest('STATE').body.state, 'PAUSED');
});

test('sixty seconds of healthy idle needs no input ACK and keeps the session open', async t => {
  const f = await fixture(); t.after(() => f.peer.dispose()); await f.ready(); await f.peer.outbound;
  for (let i = 0; i < 60; i++) {
    f.advance(1000); f.tick(); await f.peer.outbound;
    await f.signal('HEARTBEAT'); await f.peer.outbound;
  }
  assert.deepEqual(f.calls.stops, []); assert.equal(f.latest('INPUT_ACK'), undefined);
  assert.equal(f.calls.arms.length, 1);
});
