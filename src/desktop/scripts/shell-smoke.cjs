// Real Electron window and bundled UI with an isolated profile and mock API.
const { _electron, expect } = require('../../frontend/node_modules/@playwright/test')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')

;(async () => {
  const project = path.resolve(__dirname, '..')
  const profile = mkdtempSync(path.join(tmpdir(), 'meet-shell-smoke-'))
  const output = path.join(project, 'test-results', 'shell')
  mkdirSync(output, { recursive: true })
  rmSync(path.join(output, 'receipt.json'), { force: true })
  let signedIn = false
  const requests = []
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname
    requests.push(pathname)
    if (pathname === '/api/v1.0/config/') return res.end(JSON.stringify({
      work: { enabled: true }, feedback: { url: '' }, background_image: {},
      subtitle: { enabled: false }, telephony: { enabled: false },
      livekit: { url: '', default_sources: [] }, is_silent_login_enabled: false,
    }))
    if ((/^\/api\/v1.0\/users\/me\/?$/.test(pathname) || pathname === '/api/v1.0/users/shell-fixture/') && signedIn) return res.end(JSON.stringify({
      id: 'shell-fixture', email: 'fixture@example.invalid', full_name: '桌面外壳验证',
      language: 'zh-CN', timezone: 'Asia/Shanghai',
    }))
    if (pathname.endsWith('/work/capabilities/')) return res.end(JSON.stringify({ enabled: true, local_agent_enabled: true }))
    if (pathname.includes('/approvals/')) return res.end('[]')
    if (signedIn && pathname === '/api/v1.0/rooms/recent-meetings/') return res.end('[]')
    if (signedIn && ['/api/v1.0/rooms/', '/api/v1.0/directory/members/', '/api/v1.0/work/tasks/'].includes(pathname)) return res.end(JSON.stringify({ results: [], count: 0, next: null, previous: null }))
    res.writeHead(401); res.end(JSON.stringify({ detail: 'Synthetic anonymous service' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, WEMEET_USER_DATA: profile, WEMEET_SERVICE_URL: origin, WEMEET_OIDC_ISSUER: origin }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const checks = [], errors = []
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [project], env, timeout: 30000 })
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    const titlebar = page.getByTestId('desktop-titlebar')
    await expect(titlebar).toBeVisible()
    await expect(page.locator('[data-attr="login"]:visible').first()).toBeVisible()
    assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false)
    assert.equal(await titlebar.locator('button').count(), 1)
    checks.push('anonymous-titlebar-and-no-menubar')

    signedIn = true
    await page.goto(origin + '/work')
    await expect(page.locator('nav[data-desktop-rail]')).toBeVisible()
    await expect(titlebar.locator('button')).toHaveCount(3)
    await expect(page.getByTestId('rail-/work')).toBeVisible()
    assert.equal(await titlebar.evaluate(el => getComputedStyle(el).webkitAppRegion), 'drag')
    assert.equal(await titlebar.locator('button').first().evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag')
    const layout = await page.evaluate(() => ({
      bar: document.querySelector('.desktop-titlebar').getBoundingClientRect().bottom,
      rail: document.querySelector('nav[data-desktop-rail]').getBoundingClientRect().top,
      main: document.querySelector('main').getBoundingClientRect().bottom,
      viewport: innerHeight,
      barColor: getComputedStyle(document.querySelector('.desktop-titlebar')).backgroundColor,
      railColor: getComputedStyle(document.querySelector('nav')).backgroundColor,
    }))
    assert.equal(layout.bar, layout.rail)
    assert.ok(layout.main <= layout.viewport + 1)
    assert.equal(layout.barColor, layout.railColor)
    await page.screenshot({ path: path.join(output, 'workspace-light.png') })
    checks.push('integrated-surface-drag-regions-and-viewport-sizing')

    const toggle = page.getByTestId('rail-collapse-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    assert.equal(await page.locator('nav[data-desktop-rail]').evaluate(el => el.getBoundingClientRect().width), 64)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await titlebar.locator('button').nth(1).click()
    await expect(page.getByTestId('global-search-input')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('global-search-input')).toBeHidden()
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('global-search-input')).toBeVisible()
    await page.keyboard.press('Escape')
    checks.push('rail-toggle-and-titlebar-search-and-ctrl-k')

    await app.evaluate(({ BrowserWindow, Menu, dialog }) => {
      const win = BrowserWindow.getAllWindows()[0]
      globalThis.shellThemeCalls = []
      const original = win.setTitleBarOverlay.bind(win)
      win.setTitleBarOverlay = value => { globalThis.shellThemeCalls.push(value); original(value) }
      Menu.prototype.popup = function () { globalThis.shellMenuLabels = this.items.map(item => item.label) }
      dialog.showMessageBox = async (_win, options) => {
        globalThis.shellDialog = options.message
        return { response: 0, checkboxChecked: false }
      }
    })
    await titlebar.locator('button').last().click()
    await expect.poll(() => app.evaluate(() => globalThis.shellMenuLabels)).toEqual(['We-Meet', '编辑', '窗口'])
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] })
    })
    await expect.poll(() => app.evaluate(() => globalThis.shellDialog)).toContain('重新加载会断开')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    checks.push('more-menu-guarded-reload-and-cancel-close')

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expect.poll(() => app.evaluate(() => globalThis.shellThemeCalls.at(-1)?.color)).toBe('#1e2024')
    await page.screenshot({ path: path.join(output, 'workspace-dark.png') })
    assert.equal(await page.evaluate(async () => {
      try { await window.weMeetDesktop.shell.setTheme('invalid'); return 'accepted' } catch { return 'rejected' }
    }), 'rejected')
    checks.push('dark-native-controls-and-bounded-theme-ipc')

    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['control'] })
    })
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()), 0.5)
    assert.equal(await page.evaluate(() =>
      document.querySelector('.desktop-titlebar').getBoundingClientRect().bottom ===
      document.querySelector('nav[data-desktop-rail]').getBoundingClientRect().top
    ), true)
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode: '0', modifiers: ['control'] })
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
    await expect(titlebar).toBeHidden()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('root')).paddingTop)).toBe('0px')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
    await expect(titlebar).toBeVisible()
    checks.push('zoom-maximize-restore-and-native-fullscreen')

    // Preview a real room route without joining a meeting or capturing media.
    await page.goto(origin + '/abc-defg-hij')
    await expect(titlebar).toBeVisible()
    await expect(page.locator('main')).toBeVisible()
    assert.ok(await page.locator('main').evaluate(el => el.getBoundingClientRect().top >= 39))
    checks.push('meeting-preview-reserves-titlebar-space')
    assert.deepEqual(errors, [])
    writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ passed: true, checks, limitation: 'Mock API; no real meeting or installer. OS DPI and native pointer drag need manual acceptance.' }, null, 2))
    console.log('Desktop shell smoke passed:', checks.join(', '))
  } finally {
    writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify({ errors, requests }, null, 2))
    if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}) }
    server.closeAllConnections(); server.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
