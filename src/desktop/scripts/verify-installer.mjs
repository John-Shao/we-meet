// Audit a locally built NSIS payload without installing or launching the app.
// Native probe uses a synthetic model key and never submits a task.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, stat, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { rendererConfig } from './renderer-config.mjs'
import { verifyRenderer, verifyPackagedRenderer } from './renderer-provenance.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const release = path.join(root, 'release')
const output = path.join(root, 'test-results', `installer-${pkg.version}.json`)
await rm(output, { force: true })
const sevenZip = process.env.WEMEET_7ZA
if (!sevenZip || !(await stat(sevenZip)).isFile()) throw new Error('Set WEMEET_7ZA to the local 7za executable')
const manifest = JSON.parse(await readFile(path.join(release, `We-Meet-${pkg.version}-manifest.json`), 'utf8'))
assert.equal(manifest.version, pkg.version)
assert.equal(manifest.file, `We-Meet-${pkg.version}-setup.exe`)
const artifact = path.join(release, manifest.file)
const digest = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
assert.equal((await stat(artifact)).size, manifest.bytes)
assert.equal(await digest(artifact), manifest.sha256)
const renderer = await verifyRenderer(path.resolve(root, '../frontend'), root, path.join(root, 'dist/renderer'), rendererConfig())
const temporary = await mkdtemp(path.join(os.tmpdir(), 'meet-installer-audit-'))
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const { ManagedRuntime } = require('../dist/managed-runtime.js')
const { LocalWorkClient } = require('../dist/local-work.js')
let client
try {
  console.log('Extracting verified installer payload without installation')
  execFileSync(sevenZip, ['x', '-y', `-o${temporary}`, artifact, 'resources/app.asar', 'resources/local-agent/*'], { windowsHide: true, stdio: 'pipe', timeout: 60000, maxBuffer: 2_000_000 })
  const archive = path.join(temporary, 'resources', 'app.asar')
  assert.equal(await digest(archive), manifest.packagedAsarSha256)
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  assert.equal(packaged.version, pkg.version)
  const provenance = verifyPackagedRenderer(archive, renderer)
  assert.deepEqual(provenance, manifest.rendererProvenance)
  // Also compare compiled main/preload/coordinator and runtime descriptors to
  // the fixed source build, including files omitted from the renderer identity.
  let distFiles = 0
  const inspect = async (directory, prefix = 'dist') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), packagedPath = path.join(prefix, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Desktop build links are unsupported')
      if (entry.isDirectory()) await inspect(file, packagedPath)
      else if (entry.isFile() && !entry.name.endsWith('.map')) {
        assert.deepEqual(asar.extractFile(archive, packagedPath), await readFile(file))
        distFiles++
      }
    }
  }
  await inspect(path.join(root, 'dist'))
  const descriptor = JSON.parse(asar.extractFile(archive, path.join('dist', 'bundled-runtime.json')).toString('utf8'))
  assert.deepEqual(descriptor, manifest.bundledRuntime)
  const bundled = path.join(temporary, 'resources', 'local-agent')
  const runtime = new ManagedRuntime(bundled, path.join(temporary, 'state'), descriptor)
  await runtime.verify(path.join(bundled, descriptor.version), descriptor)
  console.log('Installer ASAR, renderer and full runtime inventory verified; probing native adapter')
  const workspace = path.join(temporary, '本地 workspace')
  await mkdir(workspace)
  client = new LocalWorkClient({ executable: path.join(bundled, descriptor.version, 'work-agent-local.exe'), apiKey: 'sk-synthetic-package-only-123456', model: 'deepseek-flash' }, path.join(temporary, 'native-state'))
  const capabilities = await client.request('capabilities')
  assert.equal(capabilities.ready, true)
  assert.equal(capabilities.engine, 'dsh')
  assert.equal(capabilities.execution, 'local')
  const grant = await client.request('grant', { path: await realpath(workspace) })
  assert.equal(grant.path, await realpath(workspace))
  assert.deepEqual(await client.request('list'), [])
  await client.close(); client = undefined
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ passed: true, tested_at: new Date().toISOString(), version: pkg.version, installer_sha256: manifest.sha256, source_revision: manifest.sourceRevision, source_tree_dirty_at_build: manifest.workingTreeDirty, asar_sha256: manifest.packagedAsarSha256, compiled_dist_files_verified: distFiles, renderer: provenance, runtime: descriptor, native_probe: { ready: true, engine: capabilities.engine, execution: capabilities.execution, requests: ['capabilities', 'grant', 'list'] }, supplier_calls: 0, limitation: 'Actual NSIS payload extracted and checked; actual bundled native adapter handshake/grant with synthetic key. No installation, app login, paid execution, clean Windows VM, interactive picker or formal signing acceptance.' }, null, 2) + '\n')
  console.log(`Installer payload acceptance passed; ${distFiles} compiled files, zero model calls`)
} finally {
  await client?.close()
  const resolved = path.resolve(temporary)
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('meet-installer-audit-')) throw new Error('Unexpected installer audit cleanup target')
  await rm(resolved, { recursive: true, force: true })
}
