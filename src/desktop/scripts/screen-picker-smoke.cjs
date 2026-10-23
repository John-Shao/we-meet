// Screen/window picker acceptance: both entry points, thumbnails, choose and cancel.
const { _electron } = require('../../frontend/node_modules/@playwright/test')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const project = path.resolve(__dirname, '..')
  const profile = mkdtempSync(path.join(tmpdir(), 'we-meet-screen-picker-'))
  const output = path.join(project, 'test-results')
  mkdirSync(output, { recursive: true })

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          jwks_uri: origin + '/jwks',
        })
      )
      return
    }
    if (req.url === '/api/v1.0/users/me')
      return res.end(JSON.stringify({ detail: 'Not authenticated' }))
    if (req.url === '/api/v1.0/config/')
      return res.end(
        JSON.stringify({
          feedback: { url: '' },
          background_image: {},
          subtitle: { enabled: false },
          telephony: { enabled: false },
          livekit: { url: '', force_wss_protocol: true, default_sources: [] },
          is_silent_login_enabled: true,
        })
      )
    res.statusCode = 401
    res.end(JSON.stringify({ detail: 'Not authenticated' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = {
    ...process.env,
    WEMEET_USER_DATA: profile,
    WEMEET_SERVICE_URL: origin,
    WEMEET_OIDC_ISSUER: origin,
  }
  delete env.ELECTRON_RUN_AS_NODE

  const installShareButton = (page) =>
    page.evaluate(() => {
      if (document.getElementById('test-share')) return
      const button = document.createElement('button')
      button.id = 'test-share'
      button.textContent = 'share'
      button.style.cssText =
        'position:fixed;left:12px;bottom:70px;z-index:2147483647;width:110px;height:40px;background:#1570ef;color:#fff;border-radius:8px;border:0;font:14px sans-serif'
      button.addEventListener('click', async () => {
        window.__shareDone = false
        window.__shareResult = null
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          })
          const track = stream.getVideoTracks()[0]
          window.__share = { stream, track }
          window.__shareResult = {
            ok: true,
            label: track?.label,
            settings: track?.getSettings(),
          }
        } catch (error) {
          window.__shareResult = {
            ok: false,
            name: error.name,
            message: error.message,
          }
        } finally {
          window.__shareDone = true
        }
      })
      document.body.appendChild(button)
    })

  const focusWindow = async (suffix) =>
    app.evaluate(({ BrowserWindow }, target) => {
      const win = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().endsWith(target)
      )
      if (!win) throw new Error('Window not found: ' + target)
      win.show()
      win.focus()
      win.moveTop()
      return { visible: win.isVisible(), focused: win.isFocused() }
    }, suffix)

  const waitForPicker = async (originPage) => {
    for (let i = 0; i < 150; i++) {
      const picker = app.windows().find((page) => {
        if (page.isClosed()) return false
        try {
          return new URL(page.url()).pathname === '/share-picker'
        } catch {
          return false
        }
      })
      if (picker) return picker
      await sleep(100)
    }
    if (originPage) {
      console.error(
        'share state',
        await originPage.evaluate(() => ({
          done: window.__shareDone,
          result: window.__shareResult,
        }))
      )
    }
    console.error(
      'windows',
      app.windows().map((window) => window.url())
    )
    throw new Error('Screen picker window did not open')
  }

  const waitPickerClosed = async (picker) => {
    for (let i = 0; i < 100; i++) {
      if (picker.isClosed()) return
      await sleep(100)
    }
    throw new Error('Screen picker window did not close')
  }

  const waitPickerVisible = async () => {
    for (let i = 0; i < 50; i++) {
      const visible = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().endsWith('/share-picker')
        )
        return !!win && win.isVisible()
      })
      if (visible) return
      await sleep(100)
    }
    throw new Error('Screen picker window did not become visible')
  }

  const openPicker = async (page) => {
    await installShareButton(page)
    await page.bringToFront()
    const box = await page.locator('#test-share').boundingBox()
    if (!box) throw new Error('Share button has no box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const picker = await waitForPicker(page)
    await picker.waitForSelector('[data-testid="screen-picker-card"]', {
      timeout: 20000,
    })
    await waitPickerVisible()
    return picker
  }

  const waitResult = async (page) => {
    await page.waitForFunction(() => window.__shareDone === true, {
      timeout: 20000,
    })
    return page.evaluate(() => window.__shareResult)
  }

  let app
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [project],
      env,
      timeout: 30000,
    })
    app.process().stdout?.on('data', (chunk) => process.stdout.write('[main] ' + chunk))
    app.process().stderr?.on('data', (chunk) => process.stdout.write('[main!] ' + chunk))
    const page = await app.firstWindow()
    await page.waitForFunction(
      () => !!document.querySelector('#root')?.textContent?.trim(),
      { timeout: 30000 }
    )

    // AI call float: the dialog is parented to the 420px call window.
    const floatPromise = app.waitForEvent('window')
    await page.evaluate(() => window.weMeetDesktop.aiCall.open())
    const float = await floatPromise
    await float.waitForFunction(
      () => new URL(window.location.href).pathname === '/ai-call-float',
      { timeout: 15000 }
    )
    await float.waitForFunction(
      () => !!document.querySelector('#root')?.textContent?.trim(),
      { timeout: 20000 }
    )
    const floatErrors = []
    float.on('pageerror', (error) => floatErrors.push(error.message))
    float.on('console', (message) => {
      if (message.type() === 'error') floatErrors.push(message.text())
    })
    console.log('float window', await focusWindow('/ai-call-float'))
    let picker = await openPicker(float)
    const pickerTitle = await picker.title()
    assert.equal(await picker.title(), '选择要共享的屏幕或窗口')
    const titles = await picker.$$eval(
      '[data-testid="screen-picker-card"] strong',
      (nodes) => nodes.map((node) => node.textContent)
    )
    assert.ok(titles.length > 0, 'picker must list at least one source')
    assert.ok(
      !titles.some((title) => title.includes('选择要共享的屏幕或窗口')),
      'picker window must not list itself: ' + pickerTitle
    )
    const groups = await picker.$$eval(
      '.screen-picker-section h2',
      (nodes) => nodes.map((node) => node.textContent)
    )
    assert.ok(groups.some((group) => group.startsWith('桌面')))
    assert.ok(groups.some((group) => group.startsWith('窗口')))
    await picker.screenshot({
      path: path.join(output, 'screen-picker-ai-call.png'),
      animations: 'disabled',
    })
    const screenCard = picker
      .locator('[data-testid="screen-picker-card"][data-kind="screen"]')
      .first()
    await screenCard.click()
    assert.equal(
      await picker.locator('[data-testid="screen-picker-start"]').isEnabled(),
      true
    )
    await picker.screenshot({
      path: path.join(output, 'screen-picker-selected.png'),
      animations: 'disabled',
    })
    await picker.click('[data-testid="screen-picker-start"]')
    const aiResult = await waitResult(float)
    if (!aiResult.ok) {
      console.error(
        'picker still open?',
        app.windows().map((window) => window.url()),
        await picker.textContent('body').catch((error) => String(error)),
        floatErrors
      )
    }
    assert.equal(aiResult.ok, true, JSON.stringify(aiResult))
    await waitPickerClosed(picker)
    assert.ok(aiResult.label, 'captured track must have a label')
    assert.ok(aiResult.settings.width > 0 && aiResult.settings.height > 0)
    await float.screenshot({
      path: path.join(output, 'screen-picker-ai-call-shared.png'),
      animations: 'disabled',
    })
    await float.evaluate(() => {
      window.__share?.stream.getTracks().forEach((track) => track.stop())
    })

    // Cancel through Escape restores the request as NotAllowedError.
    await focusWindow('/ai-call-float')
    picker = await openPicker(float)
    await picker.keyboard.press('Escape').catch(() => {})
    const cancelled = await waitResult(float)
    await waitPickerClosed(picker)
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.name, 'AbortError')

    // Meeting entry point shares a window through the same picker.
    picker = await openPicker(page)
    const windowCard = picker
      .locator('[data-testid="screen-picker-card"][data-kind="window"]')
      .first()
    assert.equal(await windowCard.count(), 1, 'at least one window is listed')
    await windowCard.click()
    await picker.click('[data-testid="screen-picker-start"]')
    const meetingResult = await waitResult(page)
    await waitPickerClosed(picker)
    assert.equal(meetingResult.ok, true, JSON.stringify(meetingResult))
    assert.ok(meetingResult.label, 'window capture must have a label')
    await page.screenshot({
      path: path.join(output, 'screen-picker-meeting-shared.png'),
      animations: 'disabled',
    })
    await page.evaluate(() => {
      window.__share?.stream.getTracks().forEach((track) => track.stop())
    })

    console.log(
      JSON.stringify(
        {
          passed: true,
          titles,
          groups,
          aiResult,
          cancelled: cancelled.name,
          meetingResult,
        },
        null,
        2
      )
    )
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
    server.closeAllConnections()
    server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
