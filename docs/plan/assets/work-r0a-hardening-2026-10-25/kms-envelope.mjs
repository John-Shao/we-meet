/**
 * Local envelope-encryption reference for R0a.
 *
 * This is NOT a production KMS: it keeps master keys in process memory, has no
 * HSM/cloud KMS, no access control, no audit and no regional key separation.
 * It exists to pin the envelope/DEK/crypto-shredding semantics before a real
 * KMS integration.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function key32(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'base64');
  if (key.length !== 32) throw new Error('master key must be 32 bytes');
  return key;
}

function wrapKey(masterKey, dek) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), wrapped };
}

function unwrapKey(masterKey, record) {
  const decipher = createDecipheriv(ALGO, masterKey, record.iv);
  decipher.setAuthTag(record.tag);
  return Buffer.concat([decipher.update(record.wrapped), decipher.final()]);
}

export class LocalEnvelopeKms {
  constructor({ masterKey } = {}) {
    this.masters = new Map();
    this.masterVersion = 1;
    this.masters.set(1, key32(masterKey ?? randomBytes(32)));
    this.tenants = new Map();
  }

  ensureTenant(tenantId) {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, { versions: new Map(), currentVersion: 0 });
      this.rotateTenantKey(tenantId);
    }
    return this.tenants.get(tenantId);
  }

  rotateTenantKey(tenantId) {
    const tenant = this.tenants.get(tenantId) ?? { versions: new Map(), currentVersion: 0 };
    const version = tenant.currentVersion + 1;
    const dek = randomBytes(32);
    const wrapped = wrapKey(this.masters.get(this.masterVersion), dek);
    tenant.versions.set(version, { ...wrapped, masterVersion: this.masterVersion });
    tenant.currentVersion = version;
    this.tenants.set(tenantId, tenant);
    return version;
  }

  encrypt(tenantId, plaintext) {
    const tenant = this.ensureTenant(tenantId);
    const record = tenant.versions.get(tenant.currentVersion);
    const dek = unwrapKey(this.masters.get(record.masterVersion), record);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, dek, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      v: 1,
      tenantId,
      keyVersion: tenant.currentVersion,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(tenantId, envelope) {
    if (!envelope || envelope.tenantId !== tenantId) throw new Error('tenant_mismatch');
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error('tenant_key_missing');
    const record = tenant.versions.get(envelope.keyVersion);
    if (!record) throw new Error('key_version_missing');
    const dek = unwrapKey(this.masters.get(record.masterVersion), record);
    const decipher = createDecipheriv(ALGO, dek, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  rotateMasterKey(newMasterKey) {
    const version = this.masterVersion + 1;
    const next = key32(newMasterKey);
    this.masters.set(version, next);
    for (const tenant of this.tenants.values()) {
      for (const record of tenant.versions.values()) {
        const dek = unwrapKey(this.masters.get(record.masterVersion), record);
        const rewrapped = wrapKey(next, dek);
        record.iv = rewrapped.iv;
        record.tag = rewrapped.tag;
        record.wrapped = rewrapped.wrapped;
        record.masterVersion = version;
      }
    }
    this.masterVersion = version;
  }

  shredTenantKey(tenantId) {
    this.tenants.delete(tenantId);
  }

  describe() {
    return {
      masterVersion: this.masterVersion,
      tenants: [...this.tenants.entries()].map(([tenantId, tenant]) => ({
        tenantId,
        currentVersion: tenant.currentVersion,
        versions: [...tenant.versions.keys()],
      })),
    };
  }
}
