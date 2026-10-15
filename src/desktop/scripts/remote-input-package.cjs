const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { isDeepStrictEqual } = require('node:util')
const { NATIVE_FILE, NATIVE_SOURCES, nativeDigest, nativeDescriptor, verifyNativeResources } = require('../dist/remote-control/native-resources.js')

async function authenticode(file) {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:WEMEET_NATIVE_SIGNATURE_FILE; @{ status = [string]$signature.Status; thumbprint = $signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress'],
  { windowsHide: true, timeout: 30000, maxBuffer: 65536, env: { ...process.env, WEMEET_NATIVE_SIGNATURE_FILE: path.resolve(file) } })
  const value = JSON.parse(stdout.trim())
  if (!value || typeof value.status !== 'string' || (value.thumbprint !== null && !/^[a-fA-F0-9]{40,128}$/.test(value.thumbprint))) throw new Error('Invalid native Authenticode result')
  return value
}

function requireSignature(signature, formal) {
  if (formal && (signature.status !== 'Valid' || !signature.thumbprint)) throw new Error('Formal release requires a valid Authenticode signature on the remote input runtime')
}

async function verifyBuild(root) {
  const built = await verifyNativeResources(path.join(root, 'dist/remote-input'))
  for (const name of NATIVE_SOURCES) {
    if (nativeDigest(await fs.readFile(path.join(root, 'native/remote-input', name))) !== built.manifest.sourceSha256[name]) throw new Error(`Native build is stale: ${name}`)
  }
  return built
}

/** Sign a staging copy, then hash it. The build output remains available for tests. */
async function stageRemoteInput(root, { sign, formal = false, signatureCheck = authenticode }) {
  root = path.resolve(root)
  const built = await verifyBuild(root)
  const staging = path.join(root, 'dist/remote-input-package')
  await fs.mkdir(staging, { recursive: true })
  const info = await fs.lstat(staging)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid native package staging directory')
  const unsigned = path.join(staging, `remote-input-signing-${randomUUID()}.exe`)
  try {
    // This temporary name is not in signExts exclusions. Only the finalized
    // fixed filename is excluded from Electron Builder's later copy/sign pass.
    await fs.copyFile(built.executable, unsigned)
    await sign(unsigned)
    const signature = await signatureCheck(unsigned)
    requireSignature(signature, formal)
    const bytes = await fs.readFile(unsigned)
    const manifest = { ...built.manifest, sha256: nativeDigest(bytes) }
    await fs.copyFile(unsigned, path.join(staging, NATIVE_FILE))
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await fs.unlink(unsigned)
    const result = await verifyNativeResources(staging, undefined, true)
    await fs.writeFile(path.join(root, 'dist/bundled-remote-input.json'), JSON.stringify(result.descriptor, null, 2) + '\n')
    return { ...result.descriptor, signature }
  } finally {
    await fs.unlink(unsigned).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function withRemoteInput(config, root) {
  if (config.beforePack && typeof config.beforePack !== 'function') throw new Error('Native packaging requires a composable beforePack hook')
  const resources = config.win?.extraResources ?? []
  if (!Array.isArray(resources) || [...(config.extraResources ?? []), ...resources].some(entry => entry.to === 'remote-input')) throw new Error('Duplicate native input resources')
  const signExts = config.win?.signExts ?? []
  // In the pinned builder, positive matches take precedence over exclusions.
  // Reject a rule that would sign the finalized bytes again after hashing.
  if (!Array.isArray(signExts) || signExts.some(rule => typeof rule !== 'string' || (!rule.startsWith('!') && NATIVE_FILE.endsWith(rule)))) throw new Error('Native signing rules would invalidate the finalized digest')
  return {
    ...config,
    files: [...(config.files ?? []), '!dist/remote-input/**/*', '!dist/remote-input-package/**/*'],
    win: { ...config.win,
      signExts: [...signExts, `!${NATIVE_FILE}`],
      extraResources: [...resources, { from: 'dist/remote-input-package', to: 'remote-input', filter: [NATIVE_FILE, 'manifest.json'] }],
    },
    beforePack: async context => {
      if (config.beforePack) await config.beforePack(context)
      if (context.electronPlatformName !== 'win32') return
      if (context.arch !== 1 || typeof context.packager.signIf !== 'function') throw new Error('Native input packaging requires Windows x64 and the pinned Electron Builder signer')
      await stageRemoteInput(root, {
        sign: file => context.packager.signIf(file),
        formal: context.packager.config.forceCodeSigning === true,
      })
    },
  }
}

async function verifyPackagedRemoteInput(resources, expected, { formal = false, signatureCheck = authenticode } = {}) {
  expected = nativeDescriptor(expected)
  const asar = require('@electron/asar')
  const packaged = nativeDescriptor(JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'dist/bundled-remote-input.json').toString('utf8')))
  if (!isDeepStrictEqual(packaged, expected)) throw new Error('Packaged native descriptor differs from build input')
  const result = await verifyNativeResources(path.join(resources, 'remote-input'), packaged, true)
  const signature = await signatureCheck(result.executable)
  requireSignature(signature, formal)
  return { ...packaged, signature, inventory_verified: true }
}

module.exports = { authenticode, verifyBuild, stageRemoteInput, withRemoteInput, verifyPackagedRemoteInput }
