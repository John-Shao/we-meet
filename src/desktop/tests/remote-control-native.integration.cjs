const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomUUID, webcrypto } = require('node:crypto')
const path = require('node:path')
const { RemoteInputHelper } = require('../dist/remote-control/native-helper.js')
const { Kind, encodeInput, encodeArm, signInput } = require('../dist/remote-control/wire.js')

const binding = () => ({ sessionId: randomUUID(), shareInstanceId: randomUUID(), inputGeneration: randomUUID(), epoch: 1 })
function wait(helper, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { helper.off('state', listener); reject(new Error(`Timeout waiting for ${name}`)) }, 5000)
    const listener = (event) => {
      if (event.event === name) { clearTimeout(timer); helper.off('state', listener); resolve(event) }
    }
    helper.on('state', listener)
  })
}

test('input encoding rejects invalid coordinates, sequence and Unicode before signing', () => {
  const event = { ...binding(), seq: 1, kind: Kind.Move, challenge: '00'.repeat(16), x: 0.5, y: 0.5 }
  for (const x of [-1, 2, NaN, Infinity]) assert.throws(() => encodeInput({ ...event, x }), /coordinate/)
  for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeInput({ ...event, seq }), /integer/)
  assert.throws(() => encodeInput({ ...event, kind: Kind.Text, text: '\ud800' }), /unicode/)
  assert.throws(() => encodeInput({ ...event, kind: Kind.Text, text: 'a'.repeat(257) }), /text/)
  const bytes = encodeInput({ ...event, kind: Kind.Text, text: '中文🙂' })
  assert.equal(bytes.length, 640)
  assert.equal(new DataView(bytes.buffer).getUint32(116, true), 4)
  assert.equal(new DataView(bytes.buffer).getUint16(120, true), '中'.charCodeAt(0))
  assert.throws(() => encodeArm(event, { left: 0, top: 0, width: 1, height: 1 }, 15001, new Uint8Array(65).fill(4)), /integer/)
})

test('WebCrypto signature covers all native binding and input bytes', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const packet = await signInput({ ...binding(), seq: 1, kind: Kind.Key, action: 1, code: 0x1d, challenge: '12'.repeat(16) }, keys.privateKey)
  const verify = (bytes) => webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, bytes.slice(640), bytes.slice(0, 640))
  assert.equal(packet.length, 704)
  assert.equal(await verify(packet), true)
  for (const offset of [8, 24, 40, 56, 60, 64, 72, 88, 96, 120]) {
    const changed = packet.slice(); changed[offset] ^= 1
    assert.equal(await verify(changed), false)
  }
})

test('WebCrypto to CNG native heartbeat, gap rejection and guardian cleanup', { skip: process.platform !== 'win32' }, async () => {
  const helper = new RemoteInputHelper()
  const events = []
  helper.on('state', (event) => events.push(event))
  try {
    await helper.start(path.join(__dirname, '../dist/remote-input'))
    const displayResult = wait(helper, 'displays'); helper.listDisplays()
    const { displays } = await displayResult
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey))
    const session = binding()
    const challengeResult = wait(helper, 'challenge'), armed = wait(helper, 'armed')
    helper.arm(session, displays[0], 15000, publicKey)
    const challenge = (await challengeResult).nonce
    await armed
    const heartbeat = wait(helper, 'heartbeatAck')
    helper.input(await signInput({ ...session, challenge, seq: 1, kind: Kind.Heartbeat }, keys.privateKey))
    assert.equal((await heartbeat).seq, 1)
    const closed = wait(helper, 'closed')
    helper.input(await signInput({ ...session, challenge, seq: 2, kind: Kind.Key, action: 1, code: 0x1d }, keys.privateKey))
    assert.equal((await closed).reason, 'input_gap')
    assert.equal(events.some((event) => event.event === 'inputAck'), false)
  } finally {
    const terminated = wait(helper, 'terminated'); helper.stop()
    assert.equal((await terminated).cleanup, 1)
  }
})
