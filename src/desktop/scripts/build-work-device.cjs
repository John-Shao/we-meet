// Build the Work device Broker (src/device, work-device crate) and stage the executable
// under dist/work-device with its hash manifest. The release toolchain is the crate's own
// rust-toolchain.toml (stable, x86_64-pc-windows-gnu, MinGW-w64 linker on PATH) — the same
// toolchain the Work device gates CI job uses. Requires cargo on PATH.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const crate = path.resolve(root, '../device')
execFileSync('cargo', ['build', '--release', '--bin', 'work-device'], { cwd: crate, stdio: 'inherit' })
const built = path.join(crate, 'target', 'release', 'work-device.exe')
const staging = path.join(root, 'dist', 'work-device')
fs.mkdirSync(staging, { recursive: true })
fs.copyFileSync(built, path.join(staging, 'work-device.exe'))
const sha256 = createHash('sha256').update(fs.readFileSync(path.join(staging, 'work-device.exe'))).digest('hex')
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ file: 'work-device.exe', sha256 }, null, 2) + '\n')
console.log(`work-device staged: sha256=${sha256}`)