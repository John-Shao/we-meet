// Real Chromium + source components, isolated API fixtures; no account or backend.
// Run from src/frontend: node scripts/check-remote-control-admin-ui.mjs
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const output = resolve('test-results/remote-control-admin')
mkdirSync(output, { recursive: true })
const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
let browser
let page
const errors = []
const apiRequests = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 1000 },
  })
  let state = {
    organizationId: 'fixture-org',
    version: 'a'.repeat(64),
    valid: true,
    globalEnabled: true,
    openSessions: 1,
    members: [],
    policy: {
      enabled: true,
      controllers: null,
      targets: null,
      max_seconds: 1800,
      requests_per_minute: 3,
      rejection_cooldown_seconds: 60,
    },
  }
  const writes = []
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/remote-control-admin-harness') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
      })
    }
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname
      apiRequests.push(`${request.method()} ${path}`)
      if (path.endsWith('/directory/me/'))
        return route.fulfill({
          json: {
            organization: { id: 'fixture-org', name: '远控测试组织' },
            is_org_admin: true,
            org_role: 'administrator',
            permissions: ['org.audit.read'],
          },
        })
      if (path.endsWith('/admin/remote-control/policy/')) {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON()
          assert.equal(body.version, state.version)
          writes.push({ action: 'save', ...body })
          state = {
            ...state,
            policy: body.policy,
            version: 'b'.repeat(64),
            openSessions: 0,
            revokedSessions: 1,
            members: [{ id: 'fixture-member', name: '测试成员甲' }],
          }
        }
        return route.fulfill({ json: state })
      }
      if (path.endsWith('/admin/remote-control/emergency-close/')) {
        assert.equal(request.method(), 'POST')
        writes.push({ action: 'close', body: request.postDataJSON() })
        state = {
          ...state,
          policy: { ...state.policy, enabled: false },
          version: 'c'.repeat(64),
          openSessions: 0,
          revokedSessions: 0,
        }
        return route.fulfill({ json: state })
      }
      if (path.endsWith('/admin/remote-control/members/'))
        return route.fulfill({
          json: {
            results: [{ id: 'fixture-member', name: '测试成员甲' }],
            next_cursor: null,
          },
        })
      return route.fulfill({ json: { results: [], next: null } })
    }
    // Block external resources too: importing a component cannot contact a
    // deployment accidentally through local Vite environment configuration.
    if (url.origin !== origin) return route.abort()
    return route.continue()
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/remote-control-admin-harness`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_preamble_installed__ = true
    localStorage.setItem('i18nextLng', 'zh')
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { QueryClient, QueryClientProvider } =
      await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    const { ConfirmProvider } =
      await import('/src/components/ConfirmProvider.tsx')
    const { AdminShell } =
      await import('/src/features/admin/layout/AdminShell.tsx')
    const { AdminRemoteControl } =
      await import('/src/features/admin/pages/RemoteControl.tsx')
    document.documentElement.style.height = '100%'
    document.body.style.height = '100%'
    document.getElementById('root').style.height = '100%'
    createRoot(document.getElementById('root')).render(
      React.createElement(
        QueryClientProvider,
        {
          client: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        React.createElement(
          ConfirmProvider,
          {},
          React.createElement(
            AdminShell,
            {},
            React.createElement(AdminRemoteControl)
          )
        )
      )
    )
  })
  await page.getByRole('heading', { name: '会议远程控制' }).waitFor()
  await page.screenshot({ path: resolve(output, 'policy.png'), fullPage: true })
  await page.getByLabel('谁可以申请控制').selectOption('selected')
  await page.getByText('测试成员甲', { exact: true }).click()
  await page.getByRole('button', { name: '保存策略', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.screenshot({
    path: resolve(output, 'confirm.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await dialog.getByRole('button', { name: /确定|确认/ }).click()
  await page.getByText('策略已保存。', { exact: true }).waitFor()
  assert.deepEqual(writes[0].policy.controllers, ['fixture-member'])
  await page.getByRole('button', { name: '紧急关闭远控', exact: true }).click()
  await dialog.getByRole('button', { name: /确定|确认/ }).click()
  await page.getByLabel('允许本组织使用远程控制').waitFor()
  await page.waitForFunction(
    () => document.querySelector('input[type="checkbox"]')?.checked === false
  )
  assert.deepEqual(writes[1], { action: 'close', body: {} })
  await dialog.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.screenshot({
    path: resolve(output, 'closed-1024.png'),
    fullPage: true,
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  )
  assert.deepEqual(errors, [])
  writeFileSync(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        writes: writes.map((value) => value.action),
        pageErrors: errors,
        fixtureApi: true,
      },
      null,
      2
    )
  )
  console.log(`Remote-control admin browser check passed: ${output}`)
} catch (error) {
  await page?.screenshot({
    path: resolve(output, 'failure.png'),
    fullPage: true,
  })
  writeFileSync(
    resolve(output, 'failure.json'),
    JSON.stringify(
      { error: String(error), pageErrors: errors, apiRequests },
      null,
      2
    )
  )
  console.error(error)
  console.error(errors)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
