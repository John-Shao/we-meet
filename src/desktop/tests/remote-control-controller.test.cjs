const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { sessionKey, publicKeyBytes } = require('../dist/remote-control/authorization.js');
const { signalPayload, signSignal, SIGNAL_TOPIC, INPUT_TOPIC } = require('../dist/remote-control/signals.js');
const { Kind } = require('../dist/remote-control/wire.js');
const { ControllerTransport } = require('../dist/remote-control/controller-transport.js');
const { TargetTransport } = require('../dist/remote-control/target-transport.js');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 3));
  assert.ok(predicate(), 'Expected A/B transition');
}
async function fixture(t, videoReady = true) {
  const a = await sessionKey(), b = await sessionKey();
  const binding = { roomId: randomUUID(), roomSid: 'RM_test', sessionId: randomUUID(), shareInstanceId: randomUUID(), trackSid: 'TR_screen',
    controllerIdentity: 'A', controllerSid: 'PA_a', targetIdentity: 'B', targetSid: 'PA_b', controllerPublicKey: a.publicKey };
  let time = 1000, epoch = 1, phase = 'active', version = 3;
  const helper = new EventEmitter(), authorization = new EventEmitter();
  const calls = { arms: [], inputs: [], stops: [], aPackets: [], bPackets: [], results: [], statuses: [] };
  const hooks = { ack: true, release: true, ready: true, sendA: async () => {}, deliverB: true };
  authorization.status = () => ({ phase });
  authorization.transportState = () => {
    if (phase === 'ended') throw new Error('authorization_cancelled');
    return { binding, epoch, state: phase === 'active' ? 'ACTIVE' : 'PAUSED' };
  };
  authorization.inputGrant = () => {
    if (phase !== 'active') throw new Error('local_consent_required');
    return { binding, epoch, remainingMs: 14000, controllerPublicKey: publicKeyBytes(a.publicKey), source: { native: { left: 0, top: 0, width: 1920, height: 1080 } } };
  };
  authorization.targetSignal = (type, body, generation, seq) => signSignal(signalPayload(binding, 'target', epoch, generation, seq, type, body), b.privateKey);
  authorization.stop = reason => { if (phase === 'ended') return; calls.stops.push(reason); phase = 'ended'; authorization.emit('state'); };
  authorization.block = authorization.stop;
  authorization.pause = () => { phase = 'paused'; authorization.emit('state'); };
  helper.arm = session => {
    calls.arms.push(session);
    if (hooks.ready) queueMicrotask(() => {
      helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 });
      helper.emit('state', { event: 'armed' });
    });
  };
  helper.input = packet => {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const event = { kind: view.getUint16(60, true), seq: Number(view.getBigUint64(64, true)), packet };
    calls.inputs.push(event);
    if (hooks.ack && event.kind !== Kind.Heartbeat) queueMicrotask(() => helper.emit('state', { event: 'inputAck', seq: event.seq }));
  };
  helper.suspendCapture = () => { if (hooks.release) queueMicrotask(() => helper.emit('state', { event: 'closed', reason: 'capture_suspended', cleanup: 1 })); };
  let target;
  const controller = new ControllerTransport({ binding, targetKey: b.publicKey, privateKey: a.privateKey, now: () => time, automaticTimer: false,
    onState: state => calls.statuses.push(state), onEnd: reason => calls.stops.push(`A:${reason}`), onOneShot: applied => calls.results.push(applied),
    send: async message => {
      calls.aPackets.push(message); await hooks.sendA(message);
      await target.receive({ ...message, participantIdentity: 'A', participantSid: 'PA_a' });
    } });
  controller.lease(1, 'ACTIVE', version, time + 14000); await controller.start();
  target = new TargetTransport(authorization, helper, async message => {
    calls.bPackets.push(message);
    if (hooks.deliverB) await controller.receive({ ...message, participantIdentity: 'B', participantSid: 'PA_b' });
  }, () => time);
  await target.start(); await until(() => controller.challenge);
  controller.setHealth({ pageActive: true, captureFocused: true, videoReady });
  t.after(() => { controller.stop(); target.dispose(); });
  const capture = async () => { controller.capture(); await until(() => controller.status().phase === 'open'); };
  const heartbeat = async () => {
    controller.tick(); await until(() => controller.heartbeatPending.size === 0 && calls.bPackets.some(m => JSON.parse(new TextDecoder().decode(m.payload)).type === 'HEARTBEAT_ACK'));
  };
  return { a, b, binding, calls, hooks, helper, authorization, controller, target, capture, heartbeat,
    advance: ms => { time += ms; }, tick: () => { target.tick(); controller.tick(); },
    renew: () => controller.lease(epoch, phase === 'active' ? 'ACTIVE' : 'PAUSED', ++version, time + 14000),
    resume: async () => { epoch++; phase = 'active'; controller.lease(epoch, 'ACTIVE', ++version, time + 14000); authorization.emit('state'); await until(() => controller.challenge); } };
}

test('real A/B codecs wait for native READY and direct input to only the bound peer', async t => {
  const f = await fixture(t); f.hooks.ready = false;
  f.controller.capture(); await until(() => f.calls.arms.length === 1);
  assert.equal(f.controller.input({ kind: Kind.Key, action: 1, code: 0x1e }), false);
  f.helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 });
  f.helper.emit('state', { event: 'armed' }); await until(() => f.controller.status().phase === 'open');
  assert.equal(f.controller.input({ kind: Kind.Key, action: 1, code: 0x1e }), true);
  await until(() => f.calls.inputs.length === 1 && !f.controller.pendingInputs.size);
  assert.equal(f.calls.inputs[0].seq, 1);
  assert.ok(f.calls.aPackets.every(m => m.destinationIdentity === 'B'));
  assert.ok(f.calls.bPackets.every(m => m.destinationIdentity === 'A'));
});

test('focus loss closes immediately, awaits release and never reuses a generation or pressed input', async t => {
  const f = await fixture(t); await f.capture(); const first = f.calls.arms[0].inputGeneration; f.hooks.release = false;
  f.controller.setHealth({ pageActive: true, captureFocused: false, videoReady: true });
  assert.equal(f.controller.status().phase, 'suspending'); assert.equal(f.controller.input({ kind: Kind.Key, action: 1, code: 0x1e }), false);
  assert.throws(() => f.controller.capture(), /capture_unavailable/);
  await until(() => f.target.inputState === 'closing');
  f.helper.emit('state', { event: 'closed', reason: 'capture_suspended', cleanup: 1 });
  await until(() => f.controller.status().phase === 'suspended');
  f.controller.setHealth({ pageActive: true, captureFocused: true, videoReady: true });
  assert.equal(f.controller.status().phase, 'suspended'); await f.capture();
  assert.notEqual(f.calls.arms[1].inputGeneration, first); assert.equal(f.controller.inputSeq, 0);
});

test('heartbeats and partial cumulative ACKs never extend the first unacknowledged input deadline', async t => {
  const f = await fixture(t); await f.capture(); f.hooks.ack = false;
  f.controller.input({ kind: Kind.Key, action: 1, code: 0x1e }); await until(() => f.calls.inputs.length === 1);
  f.advance(400); f.controller.input({ kind: Kind.Key, action: 0, code: 0x1e }); await until(() => f.calls.inputs.length === 2);
  f.advance(400); f.helper.emit('state', { event: 'inputAck', seq: 1 }); await until(() => f.controller.pendingInputs.size === 1);
  await f.heartbeat(); f.advance(599); f.controller.tick(); assert.notEqual(f.controller.status().phase, 'ended');
  f.advance(1); f.controller.tick(); assert.equal(f.controller.status().phase, 'ended');
  assert.ok(f.calls.stops.includes('A:input_ack_timeout'));
});

test('one-shot text sends exactly once after READY and suspends after its execution ACK', async t => {
  const f = await fixture(t); f.hooks.ack = false;
  f.controller.setHealth({ pageActive: true, captureFocused: false, videoReady: true });
  f.controller.submitText('测试\ntext'); await until(() => f.calls.inputs.some(e => e.kind === Kind.Text));
  assert.throws(() => f.controller.submitText('duplicate'), /capture_unavailable/);
  assert.equal(f.controller.input({ kind: Kind.Key, action: 1, code: 0x1c }), false);
  assert.equal(f.calls.inputs.filter(e => e.kind !== Kind.Heartbeat).length, 1);
  f.helper.emit('state', { event: 'inputAck', seq: 1 }); await until(() => f.controller.status().phase === 'suspended');
  assert.deepEqual(f.calls.results, [true]);
});

test('one-shot shortcut does not finish on the first down ACK before the final up is sent', async t => {
  const f = await fixture(t);
  f.controller.shortcut([{ kind: Kind.Key, code: 0x1c, action: 1 }, { kind: Kind.Key, code: 0x1c, action: 0 }]);
  await until(() => f.controller.status().phase === 'suspended');
  assert.equal(f.calls.inputs.filter(e => e.kind === Kind.Key).length, 2); assert.deepEqual(f.calls.results, [true]);
});

test('B-owned pause and a new business epoch require explicit A focus handshake again', async t => {
  const f = await fixture(t); await f.capture(); f.authorization.pause(); await until(() => f.controller.status().phase === 'paused');
  assert.throws(() => f.controller.capture(), /capture_unavailable/);
  f.renew(); assert.equal(f.controller.status().phase, 'paused');
  await f.resume(); assert.equal(f.controller.status().phase, 'waiting');
  assert.equal(f.calls.arms.length, 1); await f.capture(); assert.equal(f.calls.arms.length, 2);
});

test('a stalled publish fails independently of incoming heartbeats and never retries input', async t => {
  const f = await fixture(t); await f.capture(); const held = deferred();
  f.hooks.sendA = m => m.topic === INPUT_TOPIC ? held.promise : Promise.resolve();
  f.controller.input({ kind: Kind.Button, action: 1, code: 0, x: .5, y: .5 });
  await until(() => f.calls.aPackets.some(m => m.topic === INPUT_TOPIC));
  f.advance(251); f.controller.tick(); assert.equal(f.controller.status().phase, 'ended');
  assert.ok(f.calls.stops.includes('A:remote_queue_expired')); held.resolve();
});

test('healthy idle sixty seconds has no input ACK deadline and missing heartbeat ACK still ends', async t => {
  const f = await fixture(t); await f.capture();
  for (let second = 0; second < 60; second++) {
    f.advance(1000); f.renew();
    f.helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 });
    f.target.tick(); await until(() => f.controller.challenge.deadline > 1000 + (second + 1) * 1000);
    f.controller.tick(); await until(() => f.controller.heartbeatPending.size === 0 && f.controller.waiting.size === 0);
    assert.equal(f.controller.status().phase, 'open'); assert.equal(f.controller.pendingInputs.size, 0);
  }
  f.hooks.deliverB = false; f.advance(3000); f.controller.tick();
  assert.equal(f.controller.status().phase, 'ended'); assert.ok(f.calls.stops.includes('A:target_timeout'));
});

test('initial subscription cannot assert video loss or arm before its first decoded frame', async t => {
  const f = await fixture(t, false);
  f.controller.tick(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.calls.aPackets.length, 0);
  assert.throws(() => f.controller.capture(), /capture_unavailable/);
  f.advance(1000); f.controller.setHealth({ pageActive: true, captureFocused: true, videoReady: true });
  await f.capture(); assert.equal(f.calls.arms.length, 1);
});

test('video loss pauses B but heartbeat ACK keeps that paused session alive without rearming', async t => {
  const f = await fixture(t); await f.capture();
  f.controller.setHealth({ pageActive: true, captureFocused: true, videoReady: false });
  await f.heartbeat(); assert.equal(f.authorization.status().phase, 'paused');
  for (let second = 0; second < 5; second++) {
    f.advance(1000); f.renew(); f.target.tick();
    await until(() => f.controller.challenge.deadline > 2000 + second * 1000);
    f.controller.tick(); await until(() => f.controller.heartbeatPending.size === 0 && f.controller.waiting.size === 0);
    assert.equal(f.controller.status().phase, 'paused');
  }
  assert.equal(f.calls.arms.length, 1);
});

test('cancelled one-shot reports unconfirmed and a late READY cannot type after losing page focus', async t => {
  const f = await fixture(t); f.hooks.ready = false;
  f.controller.submitText('local draft'); await until(() => f.calls.arms.length === 1);
  f.controller.setHealth({ pageActive: false, captureFocused: false, videoReady: true });
  f.helper.emit('state', { event: 'challenge', nonce: '11'.repeat(16), ttlMs: 3000 });
  f.helper.emit('state', { event: 'armed' });
  await until(() => f.controller.status().phase === 'suspended');
  assert.deepEqual(f.calls.results, [false]); assert.equal(f.calls.inputs.length, 0);
});
