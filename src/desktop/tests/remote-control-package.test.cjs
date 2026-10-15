const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const asar = require('@electron/asar')
const { NATIVE_FILE, NATIVE_SOURCES, nativeDigest, verifyNativeResources } = require('../dist/remote-control/native-resources.js')
const { withRemoteInput, stageRemoteInput, verifyBuild, verifyPackagedRemoteInput } = require('../scripts/remote-input-package.cjs')
const validSignature = async () => ({ status: 'Valid', thumbprint: 'A'.repeat(40) })
const noSignature = async () => ({ status: 'NotSigned', thumbprint: null })

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'we-meet-native-package-'))
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
    await fs.rm(root, { recursive: true, force: true })
  })
  const build = path.join(root, 'dist/remote-input'), source = path.join(root, 'native/remote-input')
  await fs.mkdir(build, { recursive: true }); await fs.mkdir(source, { recursive: true })
  const payload = Buffer.from('test-only executable bytes'), sources = {}
  for (const name of NATIVE_SOURCES) {
    const bytes = Buffer.from(`test source ${name}`)
    sources[name] = nativeDigest(bytes); await fs.writeFile(path.join(source, name), bytes)
  }
  const manifest = { protocolVersion: 1, platform: 'win32', arch: 'x64', file: NATIVE_FILE, sha256: nativeDigest(payload), sourceSha256: sources }
  await fs.writeFile(path.join(build, NATIVE_FILE), payload)
  await fs.writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest))
  return { root, build, source, manifest, payload }
}

test('Windows packaging preserves runtime and signing policy, includes only finalized native files outside ASAR', () => {
  const config = { forceCodeSigning: true, files: ['dist/**/*'], extraResources: [{ from: '.agent-runtime', to: 'local-agent' }],
    win: { target: 'nsis', signExts: ['!python.exe'] } }
  const result = withRemoteInput(config, 'test-only')
  assert.equal(result.forceCodeSigning, true); assert.equal(result.win.target, 'nsis')
  assert.deepEqual(result.extraResources, config.extraResources)
  assert.deepEqual(result.win.signExts, ['!python.exe', `!${NATIVE_FILE}`])
  assert.deepEqual(result.win.extraResources, [{ from: 'dist/remote-input-package', to: 'remote-input', filter: [NATIVE_FILE, 'manifest.json'] }])
  assert.ok(result.files.includes('!dist/remote-input/**/*')); assert.ok(result.files.includes('!dist/remote-input-package/**/*'))
  assert.throws(() => withRemoteInput({ ...config, win: { extraResources: [{ to: 'remote-input' }] } }, 'test-only'), /Duplicate/)
  for (const rule of ['.exe', NATIVE_FILE, '']) {
    assert.throws(() => withRemoteInput({ ...config, win: { signExts: [rule] } }, 'test-only'), /signing rules/)
  }
})

test('signing changes bytes before final hashing, leaves original build intact and pins final manifest', async t => {
  const f = await fixture(t), order = []
  const staged = await stageRemoteInput(f.root, { formal: true,
    sign: async file => { order.push('sign'); assert.notEqual(path.basename(file), NATIVE_FILE); await fs.appendFile(file, ' signed-test-bytes') },
    signatureCheck: async file => { order.push('verify'); assert.match((await fs.readFile(file)).toString(), /signed-test-bytes/); return validSignature() } })
  assert.deepEqual(order, ['sign', 'verify'])
  assert.deepEqual(await fs.readFile(path.join(f.build, NATIVE_FILE)), f.payload)
  assert.notEqual(staged.sha256, f.manifest.sha256)
  const pinned = JSON.parse(await fs.readFile(path.join(f.root, 'dist/bundled-remote-input.json')))
  const result = await verifyNativeResources(path.join(f.root, 'dist/remote-input-package'), pinned, true)
  assert.equal(result.descriptor.sha256, staged.sha256)
  assert.equal(result.descriptor.manifestSha256, staged.manifestSha256)
})

test('formal staging refuses unsigned helpers; internal acceptance does not pretend they are signed', async t => {
  const f = await fixture(t), options = { sign: async () => {}, signatureCheck: noSignature }
  await assert.rejects(stageRemoteInput(f.root, { ...options, formal: true }), /valid Authenticode/)
  const staged = await stageRemoteInput(f.root, options)
  assert.equal(staged.signature.status, 'NotSigned')
  assert.deepEqual((await fs.readdir(path.join(f.root, 'dist/remote-input-package'))).sort(), ['manifest.json', NATIVE_FILE])
})

test('changed source, binary, manifest file path, missing source hash or absent packaged pin is rejected', async t => {
  const f = await fixture(t)
  await fs.appendFile(path.join(f.source, 'main.cpp'), 'changed')
  await assert.rejects(verifyBuild(f.root), /stale/)
  await assert.rejects(verifyNativeResources(f.build, null), /native_manifest_invalid/)
  for (const mutate of [m => m.file = '../outside.exe', m => delete m.sourceSha256['main.cpp'], m => m.extra = true]) {
    const changed = JSON.parse(JSON.stringify(f.manifest)); mutate(changed)
    await fs.writeFile(path.join(f.build, 'manifest.json'), JSON.stringify(changed))
    await assert.rejects(verifyNativeResources(f.build), /native_manifest_invalid/)
  }
  await fs.writeFile(path.join(f.build, 'manifest.json'), JSON.stringify(f.manifest))
  await fs.appendFile(path.join(f.build, NATIVE_FILE), 'changed')
  await assert.rejects(verifyNativeResources(f.build), /native_integrity_failed/)
})

test('actual ASAR and resource inventory verification rejects tampering even when external hashes are rewritten', async t => {
  const f = await fixture(t)
  await stageRemoteInput(f.root, { sign: async () => {}, signatureCheck: noSignature })
  const expected = JSON.parse(await fs.readFile(path.join(f.root, 'dist/bundled-remote-input.json')))
  const resources = path.join(f.root, 'resources'), app = path.join(f.root, 'app'), packaged = path.join(resources, 'remote-input')
  await fs.mkdir(path.join(app, 'dist'), { recursive: true }); await fs.mkdir(packaged, { recursive: true })
  await fs.copyFile(path.join(f.root, 'dist/bundled-remote-input.json'), path.join(app, 'dist/bundled-remote-input.json'))
  await asar.createPackage(app, path.join(resources, 'app.asar'))
  for (const file of ['manifest.json', NATIVE_FILE]) await fs.copyFile(path.join(f.root, 'dist/remote-input-package', file), path.join(packaged, file))
  const verify = () => verifyPackagedRemoteInput(resources, expected, { signatureCheck: noSignature })
  assert.equal((await verify()).inventory_verified, true)
  await assert.rejects(verifyPackagedRemoteInput(resources, expected, { formal: true, signatureCheck: noSignature }), /valid Authenticode/)
  await fs.writeFile(path.join(packaged, 'unexpected.dll'), 'extra')
  await assert.rejects(verify(), /native_inventory_invalid/); await fs.unlink(path.join(packaged, 'unexpected.dll'))
  const payload = Buffer.from('substitute executable'), manifest = JSON.parse(await fs.readFile(path.join(packaged, 'manifest.json')))
  manifest.sha256 = nativeDigest(payload)
  await fs.writeFile(path.join(packaged, NATIVE_FILE), payload); await fs.writeFile(path.join(packaged, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verify(), /native_integrity_failed/)
  await fs.unlink(path.join(packaged, NATIVE_FILE)); await assert.rejects(verify(), /ENOENT/)
})
