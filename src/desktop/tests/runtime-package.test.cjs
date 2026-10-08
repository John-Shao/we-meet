const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const asar = require('@electron/asar')
const { withRuntime, verifyPackagedRuntime } = require('../scripts/runtime-package.cjs')
const digest = b => createHash('sha256').update(b).digest('hex')
const config = { forceCodeSigning: true, win: { target: 'nsis' }, extraResources: [
  { from: '.agent-runtime', to: 'local-agent', filter: ['0.3.1/**/*'] },
  { from: 'other', to: 'other', filter: ['**/*'] },
] }
test('package selects the pinned version and preserves signing policy and other resources', () => {
  for (const version of ['0.3.2', '0.4.0-rc.1']) {
    const result = withRuntime(config, { version, manifest_sha256: 'a'.repeat(64) })
    assert.deepEqual(result.extraResources[0].filter, [`${version}/**/*`])
    assert.equal(result.forceCodeSigning, true)
    assert.deepEqual(result.win, config.win)
    assert.deepEqual(result.extraResources[1], config.extraResources[1])
  }
  assert.deepEqual(config.extraResources[0].filter, ['0.3.1/**/*'])
})
test('package rejects unsafe versions, invalid hashes, missing and ambiguous runtime resources', () => {
  for (const version of ['../0.3.2', '0.3.2/../../secret', '0.3.2\\secret', '']) {
    assert.throws(() => withRuntime(config, { version, manifest_sha256: 'a'.repeat(64) }))
  }
  assert.throws(() => withRuntime(config, { version: '0.3.2', manifest_sha256: 'bad' }))
  for (const entries of [[], [config.extraResources[0], config.extraResources[0]]]) {
    assert.throws(() => withRuntime({ extraResources: entries }, { version: '0.3.2', manifest_sha256: 'a'.repeat(64) }))
  }
})
test('release verifies the runtime inside the actual asar and resources, rejecting missing, stale and tampered payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-runtime-package-test-'))
  try {
    const resources = path.join(root, 'resources')
    const source = path.join(root, 'app/dist')
    const runtime = path.join(resources, 'local-agent/0.3.2')
    await fs.mkdir(source, { recursive: true }); await fs.mkdir(runtime, { recursive: true })
    const payload = Buffer.from('test executable')
    const manifest = Buffer.from(JSON.stringify({ contract: 'work-runtime/v1', version: '0.3.2', platform: 'win32-x64',
      adapter_contract: 'work-local/v1', entry: 'work-agent-local.exe', files: [
        { name: 'work-agent-local.exe', bytes: payload.length, sha256: digest(payload) },
      ] }))
    const expected = { version: '0.3.2', manifest_sha256: digest(manifest) }
    await fs.writeFile(path.join(runtime, 'manifest.json'), manifest)
    await fs.writeFile(path.join(runtime, 'work-agent-local.exe'), payload)
    await fs.writeFile(path.join(source, 'bundled-runtime.json'), JSON.stringify(expected))
    await asar.createPackage(path.dirname(source), path.join(resources, 'app.asar'))
    assert.equal((await verifyPackagedRuntime(resources, expected)).inventory_verified, true)
    await assert.rejects(verifyPackagedRuntime(resources, { ...expected, version: '0.3.1' }))
    await fs.mkdir(path.join(resources, 'local-agent/0.3.1'))
    await assert.rejects(verifyPackagedRuntime(resources, expected))
    await fs.rmdir(path.join(resources, 'local-agent/0.3.1'))
    await fs.writeFile(path.join(runtime, 'work-agent-local.exe'), Buffer.alloc(payload.length))
    await assert.rejects(verifyPackagedRuntime(resources, expected))
    await fs.unlink(path.join(runtime, 'work-agent-local.exe'))
    await assert.rejects(verifyPackagedRuntime(resources, expected))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
