// Native Chromium with intercepted HTTP fixtures; no real document or message writes.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const id = 'f9a2cd03-14d0-461a-9311-5aeeac3ce756'
const documentId = 'b9a2cd03-14d0-461a-9311-5aeeac3ce756'
const preview = { title: '产品设计评审 · 会议纪要', payload_hash: 'a'.repeat(64), markdown: '# 产品设计评审\n\nAI 生成版本\n\n## 总结\n\n本次评审确定先完成录音、逐字稿和智能纪要的统一入口。\n\n## 待确认行动项\n\n- 补充移动端录音中断恢复测试\n  负责人待确认 / 时间待确认' }
let result, fail = true, revoked = false
const writes = []
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/export-ui-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Summary export check</title><main style="max-width:760px;padding:16px;margin:auto"><h1>产品设计评审</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/v1.0/**', async route => {
    const request = route.request(), url = new URL(request.url())
    assert.ok(url.pathname.includes('/document-exports/'))
    if (revoked) return route.fulfill({ status: 403, json: {} })
    if (request.method() === 'POST') {
      writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
      if (fail) return route.abort('failed')
      result = { id, source_id: 'version', source_kind: 'ai', language: 'zh', attempt: 1, status: 'ready', document_id: documentId, can_open: true, error_code: '' }
      return route.fulfill({ status: 202, json: { export: result } })
    }
    assert.equal(request.method(), 'GET')
    if (url.pathname.includes('/preview/')) return route.fulfill({ json: preview })
    return route.fulfill({ json: { available: true, results: result ? [result] : [] } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const mount = async () => {
    await page.goto(`${origin}/export-ui-harness`)
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
      const { SummaryExportControl } = await import('/src/features/meetings/components/SummaryExportControl.tsx')
      window.exportClient = new QueryClient()
      createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.exportClient }, React.createElement(SummaryExportControl, { viewerId: 'owner', recordId: 'record', sourceKind: 'ai', sourceId: 'version' }))))
    })
  }
  await mount()
  await page.getByRole('button', { name: '导出此版本为文档', exact: true }).click()
  await page.getByRole('button', { name: '预览文档内容', exact: true }).click()
  await page.getByRole('button', { name: '确认创建文档', exact: true }).waitFor()
  assert.equal(writes.length, 0)
  await page.screenshot({ path: 'test-results/summary-export-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/summary-export-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '确认创建文档', exact: true }).click()
  await page.getByText('暂未确认提交结果，请核对并重发原请求。', { exact: true }).waitFor()
  assert.equal(writes.length, 1)
  fail = false
  await mount()
  await page.getByRole('button', { name: '导出此版本为文档', exact: true }).click()
  await page.getByRole('button', { name: '核对并重发原请求', exact: true }).click()
  const link = page.getByRole('link', { name: '打开文档', exact: true })
  await link.waitFor()
  assert.deepEqual(writes[1], writes[0])
  assert.equal(await link.getAttribute('href'), `/docs/${documentId}`)
  revoked = true
  await page.evaluate(() => window.exportClient.invalidateQueries())
  await link.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log('Summary export UI passed: desktop/mobile preview, explicit consent, network-loss reload recovery, identical request key/body, document link and permission revocation. All writes intercepted.')
} finally { await browser.close() }
