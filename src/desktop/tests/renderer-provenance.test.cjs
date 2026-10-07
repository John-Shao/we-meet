const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

async function fixture(t) {
  const api = await import('../scripts/renderer-provenance.mjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-renderer-proof-'))
  t.after(async () => {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('meet-renderer-proof-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const frontend = path.join(root, 'frontend'), desktop = path.join(root, 'desktop')
  const output = path.join(root, 'app', 'dist', 'renderer')
  const config = { serviceOrigin: 'https://meet.test', imBaseUrl: 'https://im.test', appTitle: 'We-Meet' }
  for (const directory of [path.join(frontend, 'src'), path.join(frontend, 'public'), path.join(desktop, 'scripts'), path.join(output, 'assets')]) await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(frontend, 'src', 'page.tsx'), 'original-page')
  await fs.writeFile(path.join(frontend, 'package-lock.json'), 'original-lock')
  await fs.writeFile(path.join(frontend, '.env.production'), 'VITE_PRIVATE_TEST=synthetic-sensitive-value')
  for (const name of ['build-renderer.mjs', 'renderer-config.mjs', 'renderer-provenance.mjs']) await fs.writeFile(path.join(desktop, 'scripts', name), 'build-script')
  await fs.writeFile(path.join(output, 'index.html'), '<script src="assets/main.js"></script>')
  await fs.writeFile(path.join(output, 'assets', 'main.js'), 'window.synthetic = true')
  const record = await api.rendererBuildRecord(frontend, desktop, output, config, {})
  await fs.writeFile(path.join(output, 'desktop-build.json'), JSON.stringify(record))
  return { root, frontend, desktop, output, config, record, api, verify: () => api.verifyRenderer(frontend, desktop, output, config, {}) }
}

test('renderer provenance accepts matching build and excludes environment values from metadata', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.verify(), f.record)
  assert.equal(JSON.stringify(f.record).includes('synthetic-sensitive-value'), false)
  // Codegen output and source maps are deliberately absent from production identity.
  await fs.mkdir(path.join(f.frontend, 'src', 'styled-system'))
  await fs.writeFile(path.join(f.frontend, 'src', 'styled-system', 'generated.ts'), 'codegen')
  await fs.writeFile(path.join(f.output, 'assets', 'main.js.map'), 'debug-only')
  await f.verify()
})

for (const [name, relative] of [
  ['changed source', 'src/page.tsx'],
  ['new untracked source', 'src/new-page.tsx'],
  ['changed dependency lock', 'package-lock.json'],
  ['changed Vite environment file', '.env.production'],
]) test(`renderer provenance rejects ${name} after build`, async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.frontend, relative), 'changed')
  await assert.rejects(f.verify(), /build inputs changed/)
})

test('renderer provenance rejects config, process Vite environment and build script drift', async t => {
  const f = await fixture(t)
  await assert.rejects(f.api.verifyRenderer(f.frontend, f.desktop, f.output, { ...f.config, imBaseUrl: 'https://other.test' }, {}), /configuration changed/)
  await assert.rejects(f.api.verifyRenderer(f.frontend, f.desktop, f.output, f.config, { VITE_EXTRA: 'new' }), /build inputs changed/)
  await fs.writeFile(path.join(f.desktop, 'scripts', 'build-renderer.mjs'), 'changed')
  await assert.rejects(f.verify(), /build inputs changed/)
})

test('renderer provenance rejects tampered, missing, extra and legacy outputs', async t => {
  const f = await fixture(t), asset = path.join(f.output, 'assets', 'main.js')
  await fs.writeFile(asset, 'altered bundle')
  await assert.rejects(f.verify(), /output changed/)
  await fs.writeFile(asset, 'window.synthetic = true')
  await fs.writeFile(path.join(f.output, 'extra.js'), 'unexpected asset')
  await assert.rejects(f.verify(), /output changed/)
  await fs.rm(path.join(f.output, 'extra.js'))
  await fs.rm(asset)
  await assert.rejects(f.verify(), /output changed/)
  await fs.writeFile(path.join(f.output, 'desktop-build.json'), JSON.stringify(f.config))
  await assert.rejects(f.verify(), /provenance missing/)
})

test('release provenance verifies actual ASAR assets, not just loose output metadata', async t => {
  const f = await fixture(t), archive = path.join(f.root, 'app.asar')
  await asar.createPackage(path.join(f.root, 'app'), archive)
  assert.equal(f.api.verifyPackagedRenderer(archive, f.record).packaged_assets_verified, true)
  await fs.writeFile(path.join(f.output, 'assets', 'main.js'), 'stale packaged asset')
  await asar.createPackage(path.join(f.root, 'app'), archive)
  assert.throws(() => f.api.verifyPackagedRenderer(archive, f.record), /assets do not match/)
  const altered = structuredClone(f.record)
  altered.build.output_sha256 = '0'.repeat(64)
  assert.throws(() => f.api.verifyPackagedRenderer(archive, altered), /provenance does not match/)
})
