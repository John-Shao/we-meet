// Build the Work device Broker (src/device, work-device crate) and stage the FULL sidecar payload
// under dist/work-device with its hash manifest: the executable, the pinned Node runtime, and the
// shipped device bundle (execution-face §6.4/§6.5, 批2-7 NSIS bundle shipping). The release toolchain
// is the crate's own rust-toolchain.toml (stable, x86_64-pc-windows-gnu, MinGW-w64 linker on PATH).
// Requires cargo on PATH. The Node runtime is fetched at build time (pinned version + SHA-256, cached
// under dist/, never vendored into git) — see work-device-node.cjs.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { fetchNodeRuntime, stageBundle } = require('./work-device-node.cjs')

const root = path.resolve(__dirname, '..')
const crate = path.resolve(root, '../device')
const bundleSrc = path.resolve(root, '../work/node/device-bundle')
execFileSync('cargo', ['build', '--release', '--bin', 'work-device'], { cwd: crate, stdio: 'inherit' })
const built = path.join(crate, 'target', 'release', 'work-device.exe')
const staging = path.join(root, 'dist', 'work-device')
fs.mkdirSync(staging, { recursive: true })
fs.copyFileSync(built, path.join(staging, 'work-device.exe'))
// The pinned Node runtime + the signed bundle ship beside the Broker (main.rs derives exe_dir/node.exe
// + exe_dir/work-device-bundle/main.js). The bundle carries its own signed manifest + dev fixture profile.
const nodeExe = fetchNodeRuntime(path.join(root, 'dist', '.node-cache'))
fs.copyFileSync(nodeExe, path.join(staging, 'node.exe'))
stageBundle(staging, bundleSrc)

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const profile = JSON.parse(fs.readFileSync(path.join(staging, 'work-device-bundle', 'dev-fixture-profile.json'), 'utf8'))
const manifest = {
  file: 'work-device.exe',
  sha256: sha256(path.join(staging, 'work-device.exe')),
  nodeSha256: sha256(path.join(staging, 'node.exe')),
  runtimeDigest: profile.runtime_digest,
  toolManifestHash: profile.tool_manifest_hash,
}
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`work-device payload staged: sha256=${manifest.sha256} nodeSha256=${manifest.nodeSha256} runtimeDigest=${manifest.runtimeDigest}`)