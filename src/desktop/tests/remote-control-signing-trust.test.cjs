const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sessionKey, AUDIENCE } = require('../dist/remote-control/authorization.js');
const { SigningTrust } = require('../dist/remote-control/signing-trust.js');

const clone = value => JSON.parse(JSON.stringify(value));
async function fixture() {
  const { SignJWT } = await import('jose');
  const old = await sessionKey(), next = await sessionKey();
  const key = (pair, kid, verifyUntil = null) => ({ ...pair.publicKey, kid, alg: 'ES256', verifyUntil });
  const ring = { v: 1, revision: 1, generation: 1, activeKid: 'old', keys: [key(old, 'old')] };
  const rotated = { ...ring, revision: 2, activeKid: 'next', keys: [key(old, 'old', 1800000015), key(next, 'next')] };
  const binding = { sessionId: 'test-session' };
  const consent = { binding, epoch: 1, state: 'ACTIVE', maximumDeadline: 60000 };
  const clock = { serverTime: 1800000000, startedAt: 0, now: 100 };
  const sign = async (pair, kid, exp = 1800000015, extraHeader = {}) => new SignJWT({ v: 1,
    binding: { ...binding, epoch: 1, state: 'ACTIVE', stateVersion: 3, policyDigest: 'a'.repeat(64), maxExpiresAt: 1800001800 } })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid, ...extraHeader }).setAudience(AUDIENCE)
    .setIssuedAt(exp - 15).setExpirationTime(exp).sign(pair.privateKey);
  return { old, next, ring, rotated, consent, clock, sign };
}

test('overlap accepts the old unexpired lease and a new key without changing the consent binding', async () => {
  const f = await fixture(), trust = new SigningTrust(f.ring);
  trust.update(f.rotated, 1);
  for (const [pair, kid] of [[f.old, 'old'], [f.next, 'next']]) {
    const result = await trust.verify(await f.sign(pair, kid), f.consent, f.clock);
    assert.equal(result.remainingMs, 13900);
    assert.equal(result.stateVersion, 3);
  }
});

test('retired keys cannot authenticate a lease beyond their own retirement deadline', async () => {
  const f = await fixture(), trust = new SigningTrust(f.rotated);
  await assert.rejects(trust.verify(await f.sign(f.old, 'old', 1800000016), f.consent, { ...f.clock, serverTime: 1800000001 }), /signing_key_expired/);
  await assert.rejects(trust.verify(await f.sign(f.old, 'old'), f.consent, { ...f.clock, serverTime: 1800000015 }), /signing_key_expired/);
});

test('in-flight verification survives identical metadata and valid overlap but not revoked trust', async () => {
  const f = await fixture(), token = await f.sign(f.old, 'old');
  const trust = new SigningTrust(f.ring);
  const first = trust.verify(token, f.consent, f.clock);
  trust.update(clone(f.ring), 1); trust.update(f.rotated, 1);
  assert.equal((await first).stateVersion, 3);
  const second = trust.verify(token, f.consent, f.clock);
  assert.throws(() => trust.update({ ...f.rotated, generation: 2, revision: 3 }, 1), /signing_generation_revoked/);
  await assert.rejects(second, /signing_keys_changed/);
  await assert.rejects(trust.verify(token, f.consent, f.clock), /invalid_signing_keys/);
});

test('unknown kids, key URLs and attacker-provided JWT keys never extend trust', async () => {
  const f = await fixture(), trust = new SigningTrust(f.ring);
  await assert.rejects(trust.verify(await f.sign(f.old, 'unknown'), f.consent, f.clock), /unknown_signing_key/);
  await assert.rejects(trust.verify(await f.sign(f.old, 'old', undefined, { jku: 'https://attacker.invalid/key' }), f.consent, f.clock));
  await assert.rejects(trust.verify(await f.sign(f.next, 'old'), f.consent, f.clock));
});

test('revision rollback, same-revision rewriting, generation changes and kid reuse are rejected', async () => {
  const f = await fixture();
  for (const mutate of [
    ring => ring.revision = 1,
    ring => { ring.keys = [ring.keys[1]]; },
    ring => { ring.revision++; ring.generation++; },
    ring => { ring.revision++; ring.keys[0] = { ...ring.keys[0], ...f.next.publicKey }; ring.keys.pop(); ring.activeKid = 'old'; ring.keys[0].verifyUntil = null; },
  ]) {
    const trust = new SigningTrust(f.ring); trust.update(f.rotated, 1);
    const bad = clone(f.rotated); mutate(bad);
    assert.throws(() => trust.update(bad, 1), /signing_keys_stale|signing_generation_revoked|signing_key_reused/);
  }
  assert.throws(() => new SigningTrust(f.ring).update(f.ring, 2), /signing_generation_revoked/);
});

test('malformed or unbounded rings fail closed and caller mutation cannot change a snapshot', async () => {
  const f = await fixture();
  for (const mutate of [
    ring => ring.extra = true,
    ring => ring.keys[0].d = 'private-data',
    ring => ring.keys[0].alg = 'HS256',
    ring => ring.keys.push(clone(ring.keys[0])),
    ring => ring.keys = Array(9).fill(ring.keys[0]),
    ring => ring.activeKid = 'missing',
    ring => ring.keys[0].verifyUntil = 1800000015,
    ring => ring.generation = 0,
  ]) {
    const bad = clone(f.ring); mutate(bad);
    assert.throws(() => new SigningTrust(bad), /invalid_signing_keys/);
  }
  const trust = new SigningTrust(f.ring);
  f.ring.keys[0].x = 'bad';
  assert.equal((await trust.verify(await f.sign(f.old, 'old'), f.consent, f.clock)).stateVersion, 3);
});
