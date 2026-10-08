const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { ManagedRuntime } = require('../dist/managed-runtime');
const sha = b => createHash('sha256').update(b).digest('hex');

test('signed upgrade, failed health probe, tamper and rollback preserve activation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wemeet-runtime-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const trusted = [{ key_id: 'fixture-only', public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }];
    const make = async (version, signingKeys = keys) => {
      const directory = path.join(root, 'bundle', version);
      await fs.mkdir(directory, { recursive: true });
      const binary = Buffer.from('Fixture payload ' + version);
      await fs.writeFile(path.join(directory, 'work-agent-local.exe'), binary);
      const bytes = Buffer.from(JSON.stringify({ contract: 'work-runtime/v1', version, platform: 'win32-x64', adapter_contract: 'work-local/v1', entry: 'work-agent-local.exe', files: [{ name: 'work-agent-local.exe', bytes: binary.length, sha256: sha(binary) }] }));
      await fs.writeFile(path.join(directory, 'manifest.json'), bytes);
      await fs.writeFile(path.join(directory, 'manifest.sig.json'), JSON.stringify({ key_id: 'fixture-only', signature: sign(null, bytes, signingKeys.privateKey).toString('base64') }));
      return { directory, descriptor: { version, manifest_sha256: sha(bytes) } };
    };
    const initial = await make('0.3.0');
    const candidate = await make('0.3.1');
    const broken = await make('0.3.2');
    const untrusted = await make('0.3.3', generateKeyPairSync('ed25519'));
    const mutated = await make('0.3.4');
    const runtime = new ManagedRuntime(path.join(root, 'bundle'), path.join(root, 'state'), initial.descriptor, trusted);
    assert.equal((await runtime.resolve()).version, '0.3.0');
    await assert.rejects(runtime.install(untrusted.directory, async () => {}), /runtime_signature_invalid/);
    await assert.rejects(runtime.install(broken.directory, async () => { throw Error('probe failed'); }), /probe failed/);
    assert.equal((await runtime.resolve()).version, '0.3.0');
    assert.deepEqual(await fs.readdir(path.join(root, 'state/versions')), []);
    // A failed probe must not permanently consume this signed version.
    await runtime.install(broken.directory, async () => {});
    assert.equal((await runtime.resolve()).version, '0.3.2');
    await runtime.rollback(async () => {});
    await assert.rejects(runtime.install(mutated.directory, async executable => { await fs.appendFile(executable, 'probe tamper'); }), /runtime_integrity_failed/);
    assert.equal((await runtime.resolve()).version, '0.3.0');
    assert.equal((await fs.readdir(path.join(root, 'state/versions'))).includes('0.3.4'), false);
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const probing = new Promise(resolve => { entered = resolve; });
    const installing = runtime.install(candidate.directory, async () => { entered(); await blocked; });
    await probing;
    await assert.rejects(runtime.rollback(async () => {}), /runtime_update_busy/);
    await assert.rejects(runtime.install(mutated.directory, async () => {}), /runtime_update_busy/);
    release(); await installing;
    assert.equal((await runtime.resolve()).version, '0.3.1');
    await fs.appendFile(path.join(root, 'state/versions/0.3.1/work-agent-local.exe'), 'tamper');
    await assert.rejects(runtime.resolve(), /runtime_integrity_failed/);
    await runtime.rollback(async () => {});
    assert.equal((await runtime.resolve()).version, '0.3.0');
    const disabled = new ManagedRuntime(path.join(root, 'bundle'), path.join(root, 'disabled'), initial.descriptor);
    await assert.rejects(disabled.install(candidate.directory, async () => {}), /runtime_signing_unconfigured/);
    await fs.writeFile(path.join(initial.directory, 'extra.py'), 'unlisted');
    await assert.rejects(disabled.resolve(), /runtime_invalid_package/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
