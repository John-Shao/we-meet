// Application integration test: isolated profile, no credentials and no real writes.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')

;(async () => {
  const project = path.resolve(__dirname, '..')
  const profile = mkdtempSync(path.join(tmpdir(), 'we-meet-desktop-smoke-'))
  const output = path.join(project, 'test-results')
  mkdirSync(output, { recursive: true })
  let offline = false
  let revocations = 0
  const server = http.createServer((req, res) => {
    if (offline) { req.socket.destroy(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', jwks_uri: origin + '/jwks' })); return
    }
    if (req.url === '/token') { revocations++; res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant' })); return }
    if (req.url === '/api/v1.0/users/me') { res.writeHead(301, { Location: '/api/v1.0/users/me/' }); res.end(); return }
    if (req.url === '/api/v1.0/config/') res.end(JSON.stringify({ feedback: { url: '' }, background_image: {}, subtitle: { enabled: false }, telephony: { enabled: false }, livekit: { url: '', force_wss_protocol: true, default_sources: [] }, is_silent_login_enabled: true }))
    else { res.writeHead(401); res.end(JSON.stringify({ detail: 'Not authenticated' })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project, '--use-fake-device-for-media-stream'], env, timeout: 30000 })
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim(), { timeout: 30000 })
    assert.equal(new URL(page.url()).origin, origin)
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined')
    const initial = await page.evaluate(() => window.weMeetDesktop.getStatus())
    assert.equal(initial.connection, 'online')
    assert.equal(initial.auth, 'signed-out')
    await page.screenshot({ path: path.join(output, 'desktop-startup.png'), animations: 'disabled' })
    // Direct navigation uses packaged index.html instead of a server-side SPA route.
    await page.goto(origin + '/meeting')
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    await page.reload()
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    assert.equal(await page.evaluate(async () => (await fetch('/missing-desktop-bundle.js')).status), 404)
    // Sandbox/frame policy and lifecycle are examined through Electron's testing API.
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    const denied = await page.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); return 'allowed' }
      catch (error) { return error.name }
    })
    assert.equal(denied, 'NotAllowedError')
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    const allowed = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      const count = stream.getTracks().length; stream.getTracks().forEach(t => t.stop()); return count
    })
    assert.equal(allowed, 2)
    offline = true
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1.0/config/')).status), 503)
    await page.getByRole('status').filter({ hasText: '无法连接服务' }).waitFor()
    await page.screenshot({ path: path.join(output, 'desktop-offline.png') })
    offline = false
    await page.evaluate(() => { void window.weMeetDesktop.retry() })
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    assert.equal((await page.evaluate(() => window.weMeetDesktop.getStatus())).connection, 'online')
    await page.evaluate(() => { localStorage.setItem('old-account-marker', 'A') })
    await page.evaluate(() => { void window.weMeetDesktop.logout() })
    await page.waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim())
    assert.equal(await page.evaluate(() => localStorage.getItem('old-account-marker')), null)
    assert.deepEqual(errors, [])
    // Restart with an encrypted, expired fixture session. A revoked refresh must
    // remove both native credentials and the previous account's renderer cache.
    await page.evaluate(() => localStorage.setItem('expired-account-marker', 'fixture-A'))
    await app.evaluate(({ app, safeStorage }, fixture) => {
      if (app.getPath('userData') !== fixture.profile) throw new Error('Unexpected test profile')
      const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path')
      fs.writeFileSync(path.join(fixture.profile, 'session-v1.enc'), safeStorage.encryptString(JSON.stringify({
        serviceOrigin: fixture.origin, issuer: fixture.origin, clientId: 'desktop',
        tokens: { access: 'expired-fixture-access', refresh: 'revoked-fixture-refresh', subject: 'fixture-A', expiresAt: 1 },
      })))
    }, { profile, origin })
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = await _electron.launch({ executablePath: require('electron'), args: [project], env, timeout: 30000 })
    const restored = await app.firstWindow()
    await restored.waitForFunction(async () => (await window.weMeetDesktop?.getStatus())?.message === '登录已失效，请重新登录。')
    await restored.waitForFunction(() => !!document.querySelector('[data-attr="login"]'))
    assert.equal(await restored.evaluate(() => localStorage.getItem('expired-account-marker')), null)
    assert.equal((await restored.evaluate(() => window.weMeetDesktop.getStatus())).auth, 'signed-out')
    assert.equal(revocations, 1)
    await restored.screenshot({ path: path.join(output, 'desktop-session-expired.png'), animations: 'disabled' })
    writeFileSync(path.join(output, 'smoke.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), profile, version: initial.version, platform: process.platform, checks: ['packaged-assets', 'direct-route', 'reload', 'no-node', 'sandbox', 'minimize-restore', 'cancel-close', 'fake-media-deny-and-allow', 'offline-retry', 'logout-storage-clear', 'revoked-session-restart-clears-cache'], limitation: 'Development executable with packaged renderer; mock anonymous API and fake media devices. Not real login/business or installer acceptance.' }, null, 2))
    console.log('Desktop smoke passed; evidence: src/desktop/test-results')
  } finally {
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
    server.closeAllConnections(); server.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
