// Pinned Node runtime provisioning for the Work device sidecar (execution-face §6.5, 批2-7 ruling 甲).
// The bundle's dev fixture profile declares node_version ">=22"; the sidecar spawns with --permission
// (Node 22+). The runtime is fetched at build time from a pinned version + SHA-256 (never vendored into
// git), verified, and cached under dist/ (gitignored). Both the NSIS payload and the interop fixture
// layout use THIS same pinned node.exe so the evidence proves the shipped runtime.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Node v22.14.0 win-x64 node.exe — the official SHASUMS256.txt digest (nodejs.org and the npmmirror
// binary mirror agree). Bump version + hash together; the verify gate refuses any other byte.
const NODE_VERSION = 'v22.14.0'
const NODE_SHA256 = '33b1bc1a8aca11fd5a4f2699e51019c63c0af30cf437701d07af69be7706771b'
// China-friendly mirror first (GFW), nodejs.org as the canonical fallback.
const NODE_MIRRORS = [
  `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/win-x64/node.exe`,
  `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`,
]

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Fetch (or reuse the cached) pinned node.exe, verifying its SHA-256. Returns the cached file path. */
function fetchNodeRuntime(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`)
  if (fs.existsSync(cached) && sha256File(cached) === NODE_SHA256) return cached
  const tmp = path.join(cacheDir, `node-${NODE_VERSION}-win-x64.exe.download`)
  let lastErr
  for (const url of NODE_MIRRORS) {
    try {
      execFileSync('curl', ['-sSL', '--fail', '--max-time', '300', url, '-o', tmp], { stdio: 'inherit' })
      const got = sha256File(tmp)
      if (got !== NODE_SHA256) throw new Error(`node.exe sha256 ${got} != pinned ${NODE_SHA256} (from ${url})`)
      fs.renameSync(tmp, cached)
      return cached
    } catch (err) {
      lastErr = err
      fs.rmSync(tmp, { force: true })
    }
  }
  throw new Error(`could not fetch pinned node.exe ${NODE_VERSION}: ${lastErr}`)
}

/** Copy the shipped device bundle (with its signed manifest + dev fixture profile) into a layout. */
function stageBundle(layoutDir, bundleSrc) {
  const dest = path.join(layoutDir, 'work-device-bundle')
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(bundleSrc, dest, { recursive: true })
  return dest
}

module.exports = { NODE_VERSION, NODE_SHA256, fetchNodeRuntime, stageBundle, sha256File }