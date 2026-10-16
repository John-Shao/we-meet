const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { RemoteDesktopRuntime, publicRemoteError } = require('../dist/remote-control/runtime.js');
const { bindScreenSource } = require('../dist/remote-control/source-binding.js');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
test('IPC errors disclose only fixed public codes, including when unknown text looks like a code', () => {
  assert.equal(publicRemoteError(new Error('connection_changed')), 'connection_changed');
  assert.equal(publicRemoteError(new Error('privatecredential')), 'remote_unavailable');
  assert.equal(publicRemoteError(new Error('ENOENT: private resource path')), 'remote_unavailable');
});
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), 'Expected lifecycle transition');
}
function fixture() {
  const auth = { signedIn: true, epoch: 2, subject: 'target-identity', access: async () => 'test' };
  const room = { roomId: randomUUID(), roomSid: 'RM_test', participantSid: 'PA_target' };
  const native = { left: 0, top: 0, width: 1920, height: 1080, deviceName: 'display', devicePath: 'test-only', rotation: 0, dpiX: 96, dpiY: 96 };
  const calls = [], helpers = [], events = [];
  const state = { enabled: true, tracks: [], before: async () => {}, cleanup: 1, start: async () => {}, identity: auth.subject };
  let presence;
  const cloud = { async request(action, roomId, options = {}) {
    const startedAt = performance.now(); calls.push({ action, roomId, options });
    await state.before(action);
    let data;
    if (action === 'capabilities') data = { enabled: state.enabled, roomSid: room.roomSid,
      self: { identity: state.identity, participantSid: room.participantSid, screenTrackSids: [...state.tracks] } };
    else if (action === 'publishPresence') { presence = options.body; data = {}; }
    else if (action === 'session') data = { id: options.sessionId, state: 'PENDING', deadline: 1800000030,
      request: { roomId: room.roomId, roomSid: room.roomSid, targetIdentity: auth.subject,
        targetSid: room.participantSid, targetDeviceSessionId: presence.deviceSessionId } };
    else throw new Error('unexpected_test_action');
    return { data, serverTime: 1800000000, startedAt, receivedAt: performance.now() };
  } };
  const runtime = new RemoteDesktopRuntime({ auth, cloud, resourceRoot: 'test-only',
    probe: async () => ({ ready: true, displays: [native] }), helper: () => {
      const helper = new EventEmitter(); helper.stopped = false;
      helper.start = async () => { calls.push({ action: 'native_start' }); await state.start(); if (helper.stopped) throw new Error('native_closed'); };
      helper.stop = () => { helper.stopped = true; calls.push({ action: 'native_stop' }); };
      helper.shutdown = async () => state.cleanup;
      helpers.push(helper); return helper;
    } });
  runtime.on('state', event => events.push(event));
  const source = () => bindScreenSource({ id: 'screen:1:0', display_id: '1' },
    [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 }], [native], { toDip: rect => rect });
  const select = async () => { const ticket = runtime.beginCapture(); await runtime.captureBaseline(ticket); const binding = source(); runtime.selectedCapture(ticket, binding); return binding; };
  const bind = (c, binding, sid = 'TR_new') => runtime.bindPublishedTrack({ contextId: c.contextId, shareInstanceId: binding.shareInstanceId, trackSid: sid });
  return { runtime, auth, room, state, calls, helpers, events, source, select, bind };
}

test('main verifies authenticated identity and only advertises native capability without starting hooks', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const c = await f.runtime.capabilities(f.room);
  assert.equal(c.canBeControlled, true); assert.equal(f.helpers.length, 0);
  const published = f.calls.find(c => c.action === 'publishPresence').options.body;
  assert.match(published.deviceSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(published.participantSid, f.room.participantSid);
  f.state.identity = 'foreign-account';
  await assert.rejects(f.runtime.capabilities(f.room), /connection_changed/);
  assert.throws(() => f.runtime.forwardSignedMessage({ contextId: c.contextId, kind: 'sent', messageId: randomUUID(), ok: true }), /remote_context_changed/);
});

test('late capability response after logout cannot publish presence or resurrect a context', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const hold = deferred(); f.state.before = action => action === 'capabilities' ? hold.promise : Promise.resolve();
  const pending = f.runtime.capabilities(f.room); await until(() => f.calls.length);
  f.auth.epoch++; f.auth.signedIn = false; await f.runtime.close('account_changed'); hold.resolve();
  await assert.rejects(pending, /remote_context_changed/);
  assert.equal(f.calls.some(c => c.action === 'publishPresence'), false);
});

test('screen selection retires existing server tracks; only a new owned screen SID can bind', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const c = await f.runtime.capabilities(f.room); f.state.tracks = ['TR_old'];
  const binding = await f.select();
  await assert.rejects(f.bind(c, binding, 'TR_old'), /capture_binding_mismatch/);
  f.state.tracks = ['TR_old', 'TR_new'];
  await assert.rejects(f.bind(c, binding), /screen_share_unavailable/);
  f.state.tracks = ['TR_new']; await f.bind(c, binding);
  const updated = await f.runtime.capabilities(f.room);
  assert.equal(updated.capture.trackSid, 'TR_new');
  assert.equal(JSON.stringify(updated).includes('devicePath'), false);
  assert.equal(JSON.stringify(updated).includes('sourceId'), false);
  const next = await f.select(); await assert.rejects(f.bind(c, next), /capture_binding_mismatch/);
});

test('a publication lookup completing after source replacement cannot bind the old capture', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const c = await f.runtime.capabilities(f.room), binding = await f.select(); f.state.tracks = ['TR_new'];
  const hold = deferred(); f.state.before = () => hold.promise;
  const pending = f.bind(c, binding); f.runtime.beginCapture(); hold.resolve();
  await assert.rejects(pending, /screen_share_unavailable/);
  assert.equal(f.runtime.captures.active(f.auth.epoch), undefined);
});

test('source selection requires fresh baseline and rejects old picker results after navigation', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.capabilities(f.room);
  const ticket = f.runtime.beginCapture();
  assert.throws(() => f.runtime.selectedCapture(ticket, f.source()), /capture_binding_mismatch/);
  await f.runtime.captureBaseline(ticket); await f.runtime.close('page_navigation');
  assert.equal(f.runtime.captureCurrent(ticket), false);
  assert.throws(() => f.runtime.selectedCapture(ticket, f.source()), /capture_binding_mismatch/);
});

test('closing during native startup stops synchronously and waits for guardian outcome', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const c = await f.runtime.capabilities(f.room), binding = await f.select();
  f.state.tracks = ['TR_new']; await f.bind(c, binding);
  const start = deferred(), cleanup = deferred(); f.state.start = () => start.promise; f.state.cleanup = cleanup.promise;
  await f.runtime.showRequest({ contextId: c.contextId, sessionId: randomUUID() }); await until(() => f.calls.some(c => c.action === 'native_start'));
  let closed = false; const closing = f.runtime.close('renderer_gone').then(() => { closed = true; });
  assert.equal(f.helpers[0].stopped, true); assert.equal(closed, false);
  start.resolve(); cleanup.resolve(1); await closing;
  assert.equal(f.events.at(-1).status.phase, 'ended');
});

test('uncertain cleanup remains blocked after context recreation and cannot create another helper', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose());
  const c = await f.runtime.capabilities(f.room), binding = await f.select();
  f.state.tracks = ['TR_new']; await f.bind(c, binding);
  const start = deferred(); f.state.start = () => start.promise; f.state.cleanup = -1;
  await f.runtime.showRequest({ contextId: c.contextId, sessionId: randomUUID() }); await until(() => f.calls.some(c => c.action === 'native_start'));
  await f.runtime.close('renderer_gone'); start.resolve();
  const next = await f.runtime.capabilities(f.room);
  assert.notEqual(c.contextId, next.contextId); assert.equal(next.canBeControlled, false); assert.equal(next.status.cleanupBlocked, true);
  await assert.rejects(f.runtime.showRequest({ contextId: next.contextId, sessionId: randomUUID() }), /native_unavailable/);
  assert.equal(f.helpers.length, 1);
});

test('renderer cannot pass consent flags, arbitrary OS coordinates or an old context', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); const c = await f.runtime.capabilities(f.room);
  await assert.rejects(f.runtime.showRequest({ contextId: c.contextId, sessionId: randomUUID(), approve: true }), /invalid_remote_request/);
  await assert.rejects(f.runtime.bindPublishedTrack({ contextId: c.contextId, shareInstanceId: randomUUID(), trackSid: 'TR_new', x: 1 }), /invalid_remote_request/);
  await assert.rejects(f.runtime.stop({ contextId: randomUUID(), reason: 'local_stop' }), /remote_context_changed/);
});
