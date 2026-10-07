// Isolated installation payload test; temporary signing keys are never product trust roots.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ManagedRuntime } = require('../dist/managed-runtime');
const { LocalWorkClient } = require('../dist/local-work');

(async () => {
  const output = path.resolve(__dirname, '../../../.work-acceptance/work-cross-device-20261007');
  const installed = await fs.realpath(path.join(output, 'installed'));
  assert.ok(installed.startsWith(output + path.sep));
  const bundled = path.join(installed, 'resources/local-agent');
  const descriptor = JSON.parse(await fs.readFile(path.resolve(__dirname, '../dist/bundled-runtime.json'), 'utf8'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const trust = [{ key_id: 'isolated-installation-fixture', public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const state = path.join(output, 'installed-runtime-state');
  const manager = new ManagedRuntime(bundled, state, descriptor, trust);
  const originalPath = process.env.PATH;
  process.env.PATH = process.env.SYSTEMROOT + '\\System32;' + process.env.SYSTEMROOT + '\\System32\\WindowsPowerShell\\v1.0';
  const probe = async executable => {
    const client = new LocalWorkClient({ executable, apiKey: 'sk-isolated-no-provider-call', model: 'deepseek-flash' }, path.join(output, 'native-probes', crypto.randomUUID()));
    try {
      const c = await client.request('capabilities');
      assert.equal(c.ready, true); assert.equal(c.engine, 'dsh');
      assert.equal(c.adapter_version, '0.3.1'); assert.ok(c.features.includes('command_approval'));
      const dir = path.join(output, 'native-probe-workspace'); await fs.mkdir(dir, { recursive: true });
      assert.equal((await client.request('grant', { path: dir })).path, dir);
    } finally { await client.close(); }
  };
  try {
    await probe((await manager.resolve()).executable);
    const candidate = path.join(output, 'runtime-fixture', '0.3.2-test.1');
    await fs.cp(path.join(bundled, descriptor.version), candidate, { recursive: true, errorOnExist: true, force: false });
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
    manifest.version = '0.3.2-test.1';
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(path.join(candidate, 'manifest.json'), bytes);
    await fs.writeFile(path.join(candidate, 'manifest.sig.json'), JSON.stringify({ key_id: trust[0].key_id, signature: crypto.sign(null, bytes, keys.privateKey).toString('base64') }));
    await manager.install(candidate, probe);
    assert.equal((await manager.resolve()).version, '0.3.2-test.1');
    await fs.appendFile(path.join(state, 'versions/0.3.2-test.1/python313._pth'), '\n# fixture tamper\n');
    await assert.rejects(manager.resolve(), /runtime_integrity_failed/);
    await manager.rollback(probe);
    assert.equal((await manager.resolve()).version, descriptor.version);
    const receipt = { passed: true, installed, checks: ['installed-payload-inventory', 'native-ready-and-grant-without-system-Python-or-Node-in-PATH', 'signed-full-payload-switch', 'tamper-blocks-launch', 'verified-native-rollback'], initial_version: descriptor.version, test_version: manifest.version, limitation: 'Windows host already has development tools. PATH was restricted for the actual native child. Signed fixture reuses the same binary under a test manifest version; no production signing key.' };
    await fs.writeFile(path.join(output, 'installed-runtime-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log('Installed native payload, signed test switch, tamper rejection and rollback passed');
  } finally { process.env.PATH = originalPath; }
})().catch(e => { console.error(e); process.exitCode = 1; });
