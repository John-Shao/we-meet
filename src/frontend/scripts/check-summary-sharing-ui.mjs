// Native Chromium and intercepted API fixtures. Never grants real access or sends messages.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const person = { id: 'f9a2cd03-14d0-461a-9311-5aeeac3ce756', name: '设计评审参会人', read_summary: true, read_transcript: false, active: true }
let fail = true, revoked = false, grants = []
const writes = []
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/sharing-ui-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Sharing check</title><main style="max-width:760px;padding:16px;margin:auto"><h1>产品设计评审</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/v1.0/**', async route => {
    const request = route.request(), url = new URL(request.url())
    assert.ok(url.pathname.includes('/summary-sharing/'))
    if (revoked) return route.fulfill({ status: 403, json: {} })
    if (url.pathname.endsWith('/preview/')) {
      assert.equal(request.method(), 'POST')
      const revoke = request.postDataJSON().operation === 'revoke'
      return route.fulfill({ json: { title: '产品设计评审', preview_hash: 'a'.repeat(64), recipients: [{ ...person, after_effective_summary: true, inherited_summary: revoke, effective_transcript: revoke }] } })
    }
    if (request.method() === 'POST') {
      writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
      if (fail) return route.abort('failed')
      grants = [person]
      return route.fulfill({ json: { replayed: false } })
    }
    assert.equal(request.method(), 'GET')
    if (url.pathname.endsWith('/candidates/')) return route.fulfill({ json: { results: [person], next_cursor: null } })
    return route.fulfill({ json: { available: true, can_manage: true, results: grants, next_cursor: null } })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const mount = async () => {
    await page.goto(`${origin}/sharing-ui-harness`)
    await page.evaluate(async () => {
      const runtime = (await import('/@react-refresh')).default
      runtime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => undefined
      window.$RefreshSig$ = () => type => type
      window.__vite_plugin_react_preamble_installed__ = true
      await import('/src/styles/index.css')
      await import('/src/i18n/init.ts')
      const React = (await import('/node_modules/.vite/deps/react.js')).default
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const { QueryClient, QueryClientProvider } = await import('/node_modules/.vite/deps/@tanstack_react-query.js')
      const { SummarySharingControl } = await import('/src/features/meetings/components/SummarySharingControl.tsx')
      window.shareClient = new QueryClient()
      createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.shareClient }, React.createElement(SummarySharingControl, { viewerId: 'owner', recordId: 'record', online: true }))))
    })
    await page.getByRole('button', { name: '分享纪要', exact: true }).click()
  }
  await mount()
  await page.getByRole('checkbox', { name: person.name, exact: true }).check()
  await page.getByRole('button', { name: '预览权限变化', exact: true }).click()
  await page.getByRole('button', { name: '确认权限变更', exact: true }).waitFor()
  assert.equal(writes.length, 0)
  await page.screenshot({ path: 'test-results/summary-sharing-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/summary-sharing-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '确认权限变更', exact: true }).click()
  await page.getByText('尚未确认权限变更结果，可继续核对原操作。', { exact: true }).waitFor()
  fail = false
  await mount()
  await page.getByRole('button', { name: '核对上次权限变更', exact: true }).click()
  await page.getByText('操作已确认，当前授权已刷新。没有发送通知。', { exact: true }).waitFor()
  assert.deepEqual(writes[1], writes[0])
  await page.getByRole('button', { name: '预览撤销纪要授权', exact: true }).click()
  await page.getByText('此人仍因会议角色或记录所有权拥有访问权；撤销直接授权不会移除这项权限。', { exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/summary-sharing-revoke-mobile.png', fullPage: true })
  revoked = true
  await page.evaluate(() => window.shareClient.invalidateQueries())
  await page.getByRole('button', { name: '确认权限变更', exact: true }).waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log('Summary sharing UI passed: explicit selection/preview/confirm, desktop/mobile, lost-response reload with same request, inherited-access warning and permission revocation. All writes intercepted.')
} finally { await browser.close() }
