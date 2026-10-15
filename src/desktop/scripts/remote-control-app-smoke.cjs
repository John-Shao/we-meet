// Run the complete unpacked app with a fresh profile. No login, meeting, input,
// installation or changes to the user's existing desktop profile.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const executable = process.env.WEMEET_REMOTE_PACKAGE_EXE
  if (!executable || !path.isAbsolute(executable)) throw new Error('Set WEMEET_REMOTE_PACKAGE_EXE to the absolute unpacked We-Meet.exe path')
  const archive = path.join(path.dirname(executable), 'resources/app.asar')
  const mainSource = require('@electron/asar').extractFile(archive, 'dist/main.js').toString('utf8')
  if (!mainSource.includes('no-default-protocol-registration')) throw new Error('This package lacks isolated protocol registration support; rebuild before running the smoke test')
  const output = path.resolve(__dirname, '../test-results')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'remote-app-profile-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.WEMEET_USER_DATA
  const app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`, '--no-default-protocol-registration'], env, timeout: 30000 })
  try {
    const runtime = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(),
      userData: app.getPath('userData'), electron: process.versions.electron,
      protocolRegistrationSuppressed: app.commandLine.hasSwitch('no-default-protocol-registration'),
    }))
    assert.equal(path.resolve(runtime.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'Refuse to test a non-isolated profile')
    assert.equal(runtime.packaged, true)
    assert.equal(runtime.protocolRegistrationSuppressed, true)
    assert.match(runtime.appPath, /resources[\\/]app\.asar$/)
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.name))
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim(), { timeout: 45000 })
    await page.waitForFunction(async () => (await window.weMeetDesktop?.getStatus())?.connection !== 'connecting', { timeout: 45000 })
    const status = await page.evaluate(() => window.weMeetDesktop.getStatus())
    assert.equal(status.auth, 'signed-out')
    if (status.connection === 'online') await page.locator('[data-attr="login"]:visible').first().waitFor({ timeout: 30000 })
    else await page.getByRole('status').filter({ hasText: '无法连接服务' }).waitFor({ timeout: 30000 })
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration }
    })
    assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false })
    const probe = await app.evaluate(async ({ app }) => {
      const root = app.getAppPath()
      const nativeRequire = process.getBuiltinModule('module').createRequire(root + '/package.json')
      const path = nativeRequire('node:path'), fs = nativeRequire('node:fs')
      const { RemoteInputHelper } = nativeRequire(path.join(root, 'dist/remote-control/native-helper.js'))
      const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'dist/bundled-remote-input.json'), 'utf8'))
      const result = await RemoteInputHelper.probe(path.join(process.resourcesPath, 'remote-input'), descriptor)
      return { ready: result.ready, displays: result.displays.length, descriptor }
    })
    assert.ok(probe.displays > 0)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(profile, 'startup.png'), animations: 'disabled' })
    await fs.writeFile(path.join(profile, 'report.json'), JSON.stringify({
      passed: true, testedAt: new Date().toISOString(), runtime, prefs, probe,
      auth: status.auth, connection: status.connection,
      scope: 'Complete unpacked app, fresh profile, public startup and native read-only probe; no installation, login, meeting or input injection',
    }, null, 2) + '\n')
    console.log(`Complete app smoke passed. Report: ${path.join(profile, 'report.json')}`)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
