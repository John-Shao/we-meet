const { _electron } = require('../../frontend/node_modules/@playwright/test')
const { mkdirSync, writeFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const path = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const exe = process.env.WEMEET_INSTALLED_EXE
  if (!exe) throw new Error('Set WEMEET_INSTALLED_EXE to the installed executable')
  const output = path.resolve(__dirname, '../test-results')
  mkdirSync(output, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: exe, env, timeout: 30000 })
  try {
    const page = await app.firstWindow()
    page.on('requestfailed', request => console.log('Request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
    await page.waitForFunction(async () => (await window.weMeetDesktop?.getStatus())?.connection === 'online', { timeout: 45000 })
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    const status = await page.evaluate(() => window.weMeetDesktop.getStatus())
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), electron: process.versions.electron, chrome: process.versions.chrome }))
    assert.equal(runtime.packaged, true)
    assert.equal(status.serviceOrigin, 'https://meet.we-meet.online')
    assert.equal(status.auth, 'signed-out')
    assert.match(runtime.appPath, /resources[\\/]app\.asar$/)
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    await page.goto(status.serviceOrigin + '/meeting')
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    await page.reload()
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    const second = spawn(exe, [], { env, stdio: 'ignore', windowsHide: true })
    const exitCode = await new Promise((resolve, reject) => { second.once('exit', resolve); second.once('error', reject) })
    assert.equal(exitCode, 0)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await page.goto(status.serviceOrigin)
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    await page.screenshot({ path: path.join(output, 'installed-startup.png'), animations: 'disabled' })
    assert.deepEqual(await page.evaluate(async () => {
      const result = []
      for (const url of ['/api/v1.0/config/', '/api/v1.0/users/me/', '/api/v1.0/users/me']) {
        try { const response = await fetch(url); result.push([url, response.status]) } catch { result.push([url, 'failed']) }
      }
      return result
    }), [['/api/v1.0/config/', 200], ['/api/v1.0/users/me/', 401], ['/api/v1.0/users/me', 401]])
    await app.evaluate(({ shell }) => { globalThis.desktopTestOpened = ''; shell.openExternal = async url => { globalThis.desktopTestOpened = url } })
    await page.locator('[data-attr="login"]').first().click({ noWaitAfter: true })
    await page.waitForFunction(async () => (await window.weMeetDesktop.getStatus()).auth === 'signing-in')
    // Wait on the observed system-browser handoff; no user authentication is automated.
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      target = await app.evaluate(() => globalThis.desktopTestOpened)
      if (target) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const url = new URL(target)
    assert.equal(url.origin, 'https://id.we-meet.online')
    assert.equal(url.searchParams.get('client_id'), 'desktop')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    await page.screenshot({ path: path.join(output, 'installed-login-handoff.png'), animations: 'disabled' })
    await page.evaluate(() => { void window.weMeetDesktop.logout() })
    await page.waitForFunction(async () => (await window.weMeetDesktop?.getStatus())?.auth === 'signed-out')
    writeFileSync(path.join(output, 'installed-smoke.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), executable: exe, runtime, serviceOrigin: status.serviceOrigin, checks: ['installed-asar', 'real-public-config-api', 'route-reload', 'single-instance', 'PKCE-browser-handoff'], limitation: 'Authentication handoff intercepted; real user authentication, business writes and devices remain manual.' }, null, 2))
    console.log('Installed package smoke passed')
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
})().catch(error => { console.error(error); process.exitCode = 1 })
