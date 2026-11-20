// Build the spawn fixture layout the gateway-driven interop evidence needs (execution-face 批2-7,
// closing the batch-1 "lack of spawn fixture" deferral). The real work-device.exe derives its sidecar
// inputs from the install layout (main.rs): exe_dir/node.exe + exe_dir/work-device-bundle/main.js.
// This stages exactly that layout under dist/work-device-fixture/ (gitignored): the debug binary, the
// pinned Node runtime, and the shipped bundle (signed manifest + dev fixture profile). The Go interop
// points WORK_DEVICE_BIN at this exe; the sync core's digest gate verifies the bundle before spawn.
//
// This is the EVIDENCE fixture, not the NSIS payload (work-device-package.cjs owns production shipping).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { fetchNodeRuntime, stageBundle, sha256File, NODE_VERSION } = require('./work-device-node.cjs')

const root = path.resolve(__dirname, '..')
const crate = path.resolve(root, '../device')
const bundleSrc = path.resolve(root, '../work/node/device-bundle')

// The debug binary matches the WORK_DEVICE_BIN interop convention (target/debug/work-device.exe).
execFileSync('cargo', ['build', '--bin', 'work-device'], { cwd: crate, stdio: 'inherit' })
const built = path.join(crate, 'target', 'debug', 'work-device.exe')
if (!fs.existsSync(built)) throw new Error(`built binary missing: ${built}`)

const layout = path.join(root, 'dist', 'work-device-fixture')
fs.mkdirSync(layout, { recursive: true })
fs.copyFileSync(built, path.join(layout, 'work-device.exe'))
const nodeExe = fetchNodeRuntime(path.join(root, 'dist', '.node-cache'))
fs.copyFileSync(nodeExe, path.join(layout, 'node.exe'))
stageBundle(layout, bundleSrc)

const profile = JSON.parse(fs.readFileSync(path.join(layout, 'work-device-bundle', 'dev-fixture-profile.json'), 'utf8'))
const report = {
  layout,
  node_version: NODE_VERSION,
  work_device_sha256: sha256File(path.join(layout, 'work-device.exe')),
  node_sha256: sha256File(path.join(layout, 'node.exe')),
  profile_id: profile.profile_id,
  tool_manifest_hash: profile.tool_manifest_hash,
  runtime_digest: profile.runtime_digest,
}
fs.writeFileSync(path.join(layout, 'fixture-layout.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`work-device fixture layout staged: ${layout}`)
console.log(JSON.stringify(report, null, 2))