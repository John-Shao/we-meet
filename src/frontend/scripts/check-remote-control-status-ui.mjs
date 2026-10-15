// Real Chromium and production components; isolated state, no meeting or input.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

mkdirSync(resolve('test-results'), { recursive: true })
const output = mkdtempSync(resolve('test-results/remote-control-status-'))
// Resolve the same optimized module URL used by production imports. Importing
// its cache file directly would create another React Aria collection context.
writeFileSync(
  resolve(output, 'components.ts'),
  [
    'export { Menu } from "react-aria-components"',
    'export { default as React } from "react"',
    'export { createRoot } from "react-dom/client"',
  ].join('\n') + '\n'
)
const componentsModule =
  '/' +
  relative(process.cwd(), resolve(output, 'components.ts')).replaceAll(
    '\\',
    '/'
  )
const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'remote-control-status-harness',
      configureServer(server) {
        server.middlewares.use(
          '/remote-control-status-harness',
          (_request, response) => {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(
              '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>'
            )
          }
        )
      },
    },
  ],
})
let browser, page
const errors = [],
  blocked = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      blocked.push(url.pathname)
      return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${origin}/remote-control-status-harness`)
  await page.evaluate(async (componentsModule) => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_preamble_installed__ = true
    localStorage.setItem('i18nextLng', 'zh')
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const { React, createRoot, Menu } = await import(componentsModule)
    const { ControllerContext } =
      await import('/src/features/remote-control/ControllerContext.ts')
    const { RemoteControlMenuItem } =
      await import('/src/features/rooms/livekit/components/ParticipantMenu/RemoteControlMenuItem.tsx')
    const { ControllerView } =
      await import('/src/features/remote-control/ControllerView.tsx')
    const h = React.createElement
    const root = createRoot(document.getElementById('root'))
    const room = {
      remoteParticipants: new Map(),
      on() {
        return this
      },
      off() {
        return this
      },
    }
    window.fixtureActions = { request: 0, retry: 0, input: 0 }
    const session = {
      setHealth() {},
      stop() {},
      suspend() {},
      capture() {},
      text() {},
      shortcut() {},
      input() {
        window.fixtureActions.input++
        return false
      },
    }
    const state = {
      phase: 'active',
      target: {
        identity: 'B',
        participantSid: 'PA_b',
        userId: 'fixture',
        name: '测试参会者',
      },
      input: { phase: 'waiting', epoch: 1, oneShot: false },
      deliveredText: 0,
      textOutcome: 'idle',
    }
    window.renderRemoteStatus = (ended = false, reason = 'input_ack_timeout') =>
      root.render(
        h(
          React.Suspense,
          { fallback: h('p', null, '加载中') },
          h(
            'div',
            { style: { padding: '24px' } },
            h('h1', null, '远控提示回归（测试）'),
            h(
              ControllerContext.Provider,
              {
                value: {
                  canRequest: () => false,
                  requestAvailability: () => 'desktopRequired',
                  request: () => window.fixtureActions.request++,
                },
              },
              h(
                Menu,
                { 'aria-label': '参会者菜单' },
                h(RemoteControlMenuItem, { participant: { identity: 'B' } })
              )
            ),
            h(ControllerView, {
              room,
              session,
              state: { ...state, phase: ended ? 'ended' : 'active', reason },
              onClose() {},
              onRetry: ended ? () => window.fixtureActions.retry++ : undefined,
            })
          )
        )
      )
    window.renderRemoteStatus()
  }, componentsModule)
  const menuItem = page.getByRole('menuitem', { name: '申请远程操作' })
  await menuItem.waitFor()
  assert.equal(await menuItem.getAttribute('aria-disabled'), 'true')
  await page.getByText(/对方暂不能接受远控/).waitFor()
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  await page.evaluate(() => window.renderRemoteStatus(true))
  const dialog = page.getByRole('dialog')
  const retry = dialog.getByRole('button', { name: '重新申请', exact: true })
  await retry.waitFor()
  await page.getByText(/未能确认远端响应/).waitFor()
  const geometry = await dialog.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    overflow: element.scrollHeight > element.clientHeight + 1,
  }))
  assert.equal(
    geometry.overflow,
    false,
    'Ended notice must not clip after minimizing'
  )
  assert.ok(geometry.width <= 381)
  assert.equal(await dialog.getByRole('application').count(), 0)
  assert.equal(
    await dialog.getByRole('button', { name: '开始操作', exact: true }).count(),
    0
  )
  assert.deepEqual(await page.evaluate(() => window.fixtureActions), {
    request: 0,
    retry: 0,
    input: 0,
  })
  await page.screenshot({
    path: resolve(output, 'ended-minimized.png'),
    fullPage: true,
  })
  await retry.click()
  assert.equal(await page.evaluate(() => window.fixtureActions.retry), 1)
  await page.evaluate(() =>
    window.renderRemoteStatus(true, 'private-error-detail')
  )
  await page
    .getByText('无法继续本次远程操作。请核对共享、连接和设备状态。')
    .waitFor()
  assert.equal(await page.getByText('private-error-detail').count(), 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  writeFileSync(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        testedAt: new Date().toISOString(),
        geometry,
        actions: await page.evaluate(() => window.fixtureActions),
        scope:
          'Real source UI and Chinese translations, synthetic state only; no meeting, API, native helper or input injection',
      },
      null,
      2
    ) + '\n'
  )
  console.log(`Remote-control status UI passed: ${output}`)
} catch (error) {
  await page
    ?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true })
    .catch(() => {})
  writeFileSync(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        passed: false,
        testedAt: new Date().toISOString(),
        error: error.message,
        errors,
        blocked,
      },
      null,
      2
    ) + '\n'
  )
  console.error(
    `Remote-control status UI failed: ${output}`,
    error.message,
    errors
  )
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
