import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalEnvelopeKms } from './kms-envelope.mjs';

function kms() {
  return new LocalEnvelopeKms({ masterKey: Buffer.alloc(32, 7) });
}

test('encrypt/decrypt round trip without exposing key material', () => {
  const client = kms();
  const envelope = client.encrypt('org1', 'sensitive task text');
  assert.equal(client.decrypt('org1', envelope), 'sensitive task text');
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes('wrapped'));
  assert.ok(!serialized.includes('master'));
  assert.ok(!serialized.includes('dek'));
  assert.ok(serialized.includes('ciphertext'));
});

test('cross-tenant envelope fails', () => {
  const client = kms();
  const envelope = client.encrypt('org1', 'org1 text');
  assert.throws(() => client.decrypt('org2', envelope), /tenant_mismatch/);
});

test('tenant key rotation keeps old envelopes decryptable', () => {
  const client = kms();
  const oldEnvelope = client.encrypt('org1', 'old version');
  assert.equal(client.rotateTenantKey('org1'), 2);
  const newEnvelope = client.encrypt('org1', 'new version');
  assert.equal(newEnvelope.keyVersion, 2);
  assert.notEqual(oldEnvelope.keyVersion, newEnvelope.keyVersion);
  assert.equal(client.decrypt('org1', oldEnvelope), 'old version');
  assert.equal(client.decrypt('org1', newEnvelope), 'new version');
});

test('crypto-shredding makes old ciphertext unreadable', () => {
  const client = kms();
  const envelope = client.encrypt('org1', 'shred me');
  client.shredTenantKey('org1');
  assert.throws(() => client.decrypt('org1', envelope), /tenant_key_missing/);
});

test('master key rotation rewraps DEKs and keeps content readable', () => {
  const client = kms();
  const envelope = client.encrypt('org1', 'survives master rotation');
  client.rotateMasterKey(Buffer.alloc(32, 9));
  assert.equal(client.describe().masterVersion, 2);
  assert.equal(client.decrypt('org1', envelope), 'survives master rotation');
});

test('tampered ciphertext and invalid master keys fail', () => {
  const client = kms();
  const envelope = client.encrypt('org1', 'untampered');
  const tampered = {
    ...envelope,
    ciphertext: Buffer.from('tampered').toString('base64'),
  };
  assert.throws(() => client.decrypt('org1', tampered));
  assert.throws(() => new LocalEnvelopeKms({ masterKey: Buffer.alloc(16) }), /32 bytes/);
});
