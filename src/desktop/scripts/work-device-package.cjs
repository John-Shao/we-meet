// NSIS extra-payload hook for the Work device Broker, following the remote-input house
// pattern (scripts/remote-input-package.cjs): stage a signing copy, sign it, hash the
// FINAL bytes, pin the descriptor into the asar, and exclude the finalized file from the
// builder's later copy/sign pass so the pinned digest stays valid.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { WORK_DEVICE_FILE, WORK_DEVICE_NODE_FILE, WORK_DEVICE_BUNDLE_DIR, workDeviceDescriptor, verifyWorkDevice } = require('../dist/work/broker.js')

async function stageWorkDevice(root, { sign }) {
  root = path.resolve(root)
  const built = await verifyWorkDevice(path.join(root, 'dist/work-device'))
  const staging = path.join(root, 'dist/work-device-package')
  await fs.mkdir(staging, { recursive: true })
  const info = await fs.lstat(staging)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid work device staging directory')
  const { createHash } = require('node:crypto')
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  // Sign an executable under a temporary name (not in signExts exclusions), hash the FINAL bytes,
  // then place it at its fixed filename (which IS excluded from the builder's later copy/sign pass).
  const signFinalized = async (src, destName) => {
    const unsigned = path.join(staging, `work-device-signing-${randomUUID()}${path.extname(destName)}`)
    try {
      await fs.copyFile(src, unsigned)
      await sign(unsigned)
      const bytes = await fs.readFile(unsigned)
      await fs.copyFile(unsigned, path.join(staging, destName))
      return sha256(bytes)
    } finally {
      await fs.unlink(unsigned).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  const exeSha = await signFinalized(built.executable, WORK_DEVICE_FILE)
  const nodeSha = await signFinalized(path.join(root, 'dist/work-device', WORK_DEVICE_NODE_FILE), WORK_DEVICE_NODE_FILE)
  // The bundle is data (signed-file manifest pins its bytes via runtime_digest); copy it verbatim.
  await fs.cp(path.join(root, 'dist/work-device', WORK_DEVICE_BUNDLE_DIR), path.join(staging, WORK_DEVICE_BUNDLE_DIR), { recursive: true })
  const profile = JSON.parse(await fs.readFile(path.join(staging, WORK_DEVICE_BUNDLE_DIR, 'dev-fixture-profile.json'), 'utf8'))
  await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({
    file: WORK_DEVICE_FILE, sha256: exeSha, nodeSha256: nodeSha,
    runtimeDigest: profile.runtime_digest, toolManifestHash: profile.tool_manifest_hash,
  }, null, 2) + '\n')
  const result = await verifyWorkDevice(staging)
  await fs.writeFile(path.join(root, 'dist/bundled-work-device.json'), JSON.stringify(result.descriptor, null, 2) + '\n')
  return result.descriptor
}

function withWorkDevice(config, root) {
  if (config.beforePack && typeof config.beforePack !== 'function') throw new Error('Work device packaging requires a composable beforePack hook')
  const resources = config.win?.extraResources ?? []
  if (!Array.isArray(resources) || [...(config.extraResources ?? []), ...resources].some(entry => entry.to === 'work-device')) throw new Error('Duplicate work device resources')
  const signExts = config.win?.signExts ?? []
  const finalized = [WORK_DEVICE_FILE, WORK_DEVICE_NODE_FILE]
  if (!Array.isArray(signExts) || signExts.some(rule => typeof rule !== 'string' || (!rule.startsWith('!') && finalized.some(file => file.endsWith(rule))))) throw new Error('Work device signing rules would invalidate the finalized digest')
  return {
    ...config,
    files: [...(config.files ?? []), '!dist/work-device/**/*', '!dist/work-device-package/**/*'],
    win: { ...config.win,
      signExts: [...signExts, `!${WORK_DEVICE_FILE}`, `!${WORK_DEVICE_NODE_FILE}`],
      extraResources: [...resources, { from: 'dist/work-device-package', to: 'work-device', filter: [WORK_DEVICE_FILE, WORK_DEVICE_NODE_FILE, 'manifest.json', `${WORK_DEVICE_BUNDLE_DIR}/**`] }],
    },
    beforePack: async context => {
      if (config.beforePack) await config.beforePack(context)
      if (context.electronPlatformName !== 'win32') return
      if (context.arch !== 1 || typeof context.packager.signIf !== 'function') throw new Error('Work device packaging requires Windows x64 and the pinned Electron Builder signer')
      await stageWorkDevice(root, { sign: file => context.packager.signIf(file) })
    },
  }
}

async function verifyPackagedWorkDevice(resources, expected) {
  expected = workDeviceDescriptor(expected)
  const asar = require('@electron/asar')
  const packaged = workDeviceDescriptor(JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'dist/bundled-work-device.json').toString('utf8')))
  if (!isDeepStrictEqual(packaged, expected)) throw new Error('Packaged work device descriptor differs from build input')
  await verifyWorkDevice(path.join(resources, 'work-device'), packaged)
  return { ...packaged, inventory_verified: true }
}

module.exports = { stageWorkDevice, withWorkDevice, verifyPackagedWorkDevice }