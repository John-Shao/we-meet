// Native Chromium with intercepted API fixtures; no real IM or model calls.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const id = 'f9a2cd03-14d0-461a-9311-5aeeac3ce756'
const versionId = 'b9a2cd03-14d0-461a-9311-5aeeac3ce756'
const record = { id: 'record', title: '产品设计评审', source_type: 'meeting', origin_at: '2026-09-13T00:00:00Z', revision: 2, capabilities: { read_summary: true, read_transcript: false, generate_summary: true } }
let receipt = { id, summary_id: versionId, status: 'uncertain', attempt: 2, error_code: '', created_at: record.origin_at }
let fail = true, revoked = false, missing = false
const writes = [], reads = []
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/notice-ui-harness**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Notification check</title><div id="root"></div></html>' }))
  await context.route('**/api/v1.0/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (revoked) return route.fulfill({ status: 403, json: {} })
    if (request.method() === 'POST') {
      assert.equal(url.pathname, `/api/v1.0/meeting-records/record/summary-notifications/${id}/retry/`)
      writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
      if (fail) return route.abort('failed')
      receipt = { ...receipt, status: 'delivered', attempt: 3 }
      return route.fulfill({ status: 202, json: { notification: receipt } })
    }
    assert.equal(request.method(), 'GET')
    reads.push(url.pathname + url.search)
    const reply = json => route.fulfill({ json })
    if (url.pathname.endsWith('/summary-notifications/')) return reply({ available: true, strategy: 'owners_and_initiators', legacy_delivery_unchanged: true, future_recipients: [{ id: 'owner', name: '会议所有者' }], results: [receipt] })
    if (url.pathname.endsWith('/summary-job/')) return reply({ revision: 2, generation_ready: true, job: null })
    if (url.pathname.endsWith('/summary-versions/')) {
      assert.equal(url.searchParams.get('version_id'), versionId)
      if (missing) return route.fulfill({ status: 404, json: {} })
      return reply({ next_cursor: null, results: [{ id: versionId, stage: 'final', created_at: record.origin_at, is_current: false, input_snapshot_id: 'snapshot', delivery_status: 'complete', content: { overview: '此通知对应的历史版本：先完成录音、逐字稿和智能纪要的统一入口。', decisions: [], chapters: [], action_items: [], open_questions: [] } }] })
    }
    if (url.pathname.endsWith('/document-exports/')) return reply({ available: false, results: [] })
    if (url.pathname.endsWith('/summary-sharing/')) return reply({ available: false, can_manage: false, results: [], next_cursor: null })
    assert.equal(url.pathname, '/api/v1.0/meeting-records/record/')
    return reply(record)
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const mount = async () => {
    await page.goto(`${origin}/notice-ui-harness?summary=${versionId}`)
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
      const { RecordWorkspace } = await import('/src/features/meetings/routes/MeetingRecordWorkspace.tsx')
      window.noticeClient = new QueryClient()
      createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.noticeClient }, React.createElement(RecordWorkspace, { viewerId: 'owner', recordId: 'record' }))))
    })
  }
  await mount()
  await page.getByText('正在查看通知所对应的固定纪要版本。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '智能纪要', exact: true }).getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: '纪要助手通知', exact: true }).click()
  await page.getByRole('button', { name: '再次尝试通知我', exact: true }).waitFor()
  assert.equal(writes.length, 0)
  await page.screenshot({ path: 'test-results/summary-notification-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/summary-notification-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '再次尝试通知我', exact: true }).click()
  await page.getByText('尚未确认请求结果，可继续确认同一次操作。', { exact: true }).waitFor()
  fail = false
  await mount()
  await page.getByRole('button', { name: '纪要助手通知', exact: true }).click()
  await page.getByRole('button', { name: '确认上次重试结果', exact: true }).click()
  await page.getByText('重试请求已受理，等待交付结果。', { exact: true }).waitFor()
  assert.deepEqual(writes[1], writes[0])
  assert.equal(await page.getByRole('link', { name: '查看这版纪要', exact: true }).getAttribute('href'), `/meeting/records/record?summary=${versionId}`)
  missing = true
  await page.evaluate(() => window.noticeClient.invalidateQueries({ queryKey: ['meeting-records', 'owner', 'summary-versions'] }))
  await page.getByText('这版纪要不存在或你已无权查看。', { exact: true }).waitFor()
  assert.equal(await page.getByText('此通知对应的历史版本：先完成录音、逐字稿和智能纪要的统一入口。', { exact: true }).count(), 0)
  revoked = true
  await page.evaluate(() => window.noticeClient.invalidateQueries())
  assert.equal(reads.some(path => /transcripts|human-summary|summary-automation|summaries\//.test(path)), false)
  assert.deepEqual(errors, [])
  console.log('Summary notification UI passed: pinned historical version, desktop/mobile, explicit private retry, reload recovery with same key/body, unavailable version and permission failure. All writes intercepted.')
} finally { await browser.close() }
