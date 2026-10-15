// Actual Electron Builder + packaged Electron/native readonly probe. This does
// not build the full meeting application, install software, or inject input.
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { build } = require('electron-builder')
const { withRemoteInput, verifyBuild, verifyPackagedRemoteInput } = require('./remote-input-package.cjs')
const { NATIVE_FILE, NATIVE_SOURCES, nativeDigest } = require('../dist/remote-control/native-resources.js')

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required')
  const desktop = path.resolve(__dirname, '..')
  await verifyBuild(desktop)
  const results = path.join(desktop, 'test-results')
  await fs.mkdir(results, { recursive: true })
  const project = await fs.mkdtemp(path.join(results, 'remote-input-package-'))
  for (const folder of ['dist/remote-input', 'dist/remote-control', 'native/remote-input']) await fs.mkdir(path.join(project, folder), { recursive: true })
  for (const file of [NATIVE_FILE, 'manifest.json']) await fs.copyFile(path.join(desktop, 'dist/remote-input', file), path.join(project, 'dist/remote-input', file))
  for (const file of NATIVE_SOURCES) await fs.copyFile(path.join(desktop, 'native/remote-input', file), path.join(project, 'native/remote-input', file))
  for (const file of ['native-resources.js', 'native-helper.js', 'wire.js']) await fs.copyFile(path.join(desktop, 'dist/remote-control', file), path.join(project, 'dist/remote-control', file))
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'we-meet-native-package-probe', version: '1.0.0', main: 'main.cjs', description: 'Isolated native resource verification', author: 'We-Meet', license: 'UNLICENSED' }))
  await fs.writeFile(path.join(project, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteInputHelper } = require('./dist/remote-control/native-helper.js');
app.whenReady().then(async () => {
  let report;
  try {
    if (!app.isPackaged) throw Error('not_packaged');
    const descriptor = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist/bundled-remote-input.json'), 'utf8'));
    const probe = await RemoteInputHelper.probe(path.join(process.resourcesPath, 'remote-input'), descriptor);
    report = { ok: true, packaged: app.isPackaged, ready: probe.ready, displays: probe.displays.length, electron: process.versions.electron };
  } catch (error) { report = { ok: false, reason: error.message }; }
  fs.writeFileSync(process.env.WEMEET_NATIVE_SMOKE_REPORT, JSON.stringify(report));
  app.exit(0);
});
`)
  const version = require('electron/package.json').version
  const config = withRemoteInput({ appId: 'online.we-meet.native-package-probe', productName: 'WeMeetNativePackageProbe', asar: true,
    electronVersion: version, electronDist: path.dirname(require('electron')), npmRebuild: false, forceCodeSigning: false,
    files: ['main.cjs', 'package.json', 'dist/remote-control/*.js', 'dist/bundled-remote-input.json'],
    directories: { output: path.join(project, 'output') }, win: { signExecutable: false },
  }, project)
  await build({ projectDir: project, config, dir: true, win: [], x64: true, publish: 'never' })
  const output = path.join(project, 'output/win-unpacked'), resources = path.join(output, 'resources')
  const expected = JSON.parse(await fs.readFile(path.join(project, 'dist/bundled-remote-input.json')))
  const packaged = await verifyPackagedRemoteInput(resources, expected)
  const reportFile = path.join(project, 'probe.json'), env = { ...process.env, WEMEET_NATIVE_SMOKE_REPORT: reportFile }
  delete env.ELECTRON_RUN_AS_NODE
  const probe = async () => {
    await fs.unlink(reportFile).catch(error => { if (error.code !== 'ENOENT') throw error })
    await promisify(execFile)(path.join(output, 'WeMeetNativePackageProbe.exe'), [], { env, windowsHide: true, timeout: 20000, maxBuffer: 65536 })
    return JSON.parse(await fs.readFile(reportFile))
  }
  const healthy = await probe()
  if (!healthy.ok || healthy.displays < 1) throw new Error(`Packaged native probe failed: ${JSON.stringify(healthy)}`)
  const binaryPath = path.join(resources, 'remote-input', NATIVE_FILE), manifestPath = path.join(resources, 'remote-input/manifest.json')
  const originalBinary = await fs.readFile(binaryPath), originalManifest = await fs.readFile(manifestPath)
  let rejected
  try {
    const altered = Buffer.concat([originalBinary, Buffer.from('tamper-probe')]), manifest = JSON.parse(originalManifest)
    manifest.sha256 = nativeDigest(altered)
    await fs.writeFile(binaryPath, altered); await fs.writeFile(manifestPath, JSON.stringify(manifest))
    rejected = await probe()
    if (rejected.ok || rejected.reason !== 'native_integrity_failed') throw new Error('Packaged pin did not reject paired manifest/binary tampering')
  } finally {
    await fs.writeFile(binaryPath, originalBinary); await fs.writeFile(manifestPath, originalManifest)
  }
  await verifyPackagedRemoteInput(resources, expected)
  const report = { healthy, tamper: rejected, packaged, scope: 'Isolated unsigned package; no meeting, installation or input injection' }
  await fs.writeFile(path.join(project, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Native package smoke passed. Report: ${path.join(project, 'report.json')}`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
