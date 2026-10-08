const fs = require('node:fs/promises')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

function descriptor(value) {
  if (!value || typeof value.version !== 'string' || typeof value.manifest_sha256 !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
      !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) throw new Error('Invalid bundled runtime descriptor')
  return value
}

function withRuntime(config, value) {
  descriptor(value)
  const entries = config.extraResources
  if (!Array.isArray(entries) || entries.filter(e => e.from === '.agent-runtime' && e.to === 'local-agent').length !== 1) {
    throw new Error('Exactly one bundled runtime resource is required')
  }
  return { ...config, extraResources: entries.map(e => e.from === '.agent-runtime' && e.to === 'local-agent'
    ? { ...e, filter: [`${value.version}/**/*`] } : e) }
}

async function verifyPackagedRuntime(resources, expected) {
  descriptor(expected)
  const asar = require('@electron/asar')
  const packaged = descriptor(JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'dist/bundled-runtime.json').toString('utf8')))
  if (!isDeepStrictEqual(packaged, expected)) throw new Error('Packaged runtime descriptor differs from build input')
  const root = path.join(resources, 'local-agent')
  const entries = await fs.readdir(root, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== packaged.version || !entries[0].isDirectory() || entries[0].isSymbolicLink()) {
    throw new Error('Packaged runtime versions differ from descriptor')
  }
  const { ManagedRuntime } = require('../dist/managed-runtime.js')
  const runtime = new ManagedRuntime(root, path.join(resources, '.verification-unused'), packaged)
  await runtime.verify(path.join(root, packaged.version), packaged)
  return { ...packaged, inventory_verified: true }
}

module.exports = { withRuntime, verifyPackagedRuntime }
