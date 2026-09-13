// All HTTP intercepted. No microphone, provider, or real recording is opened.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
let job = null, denied = false, posts = 0
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/live-capture-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Live capture transcription</title><main style="max-width:760px;padding:16px;margin:auto"><h1>项目设计评审 · 正在录音</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/v1.0/**', route => {
    const request = route.request()
    assert.ok(request.url().includes('/capture-sessions/capture/transcription/'))
    if (denied) return route.fulfill({ status: 403, json: {} })
    if (request.method() === 'POST') {
      posts++
      if (request.url().endsWith('/cancel/')) {
        assert.equal(request.url().endsWith('/live-job/cancel/'), true)
        job = { ...job, status: 'canceled' }
        return route.fulfill({ json: job })
      }
      assert.equal(request.postDataJSON().live, true)
      assert.ok(request.headers()['idempotency-key'])
      job = { id: 'live-job', generation: 1, mode: 'live', status: 'running', input_count: 8, acknowledged_inputs: 7, final_count: 2 }
      return route.fulfill({ status: 201, json: { job, created: true } })
    }
    if (request.url().includes('/preview/')) return route.fulfill({ json: { job_id: job.id, status: job.status, published: false, last_sequence: 2, next_after_sequence: null, results: [
      { id: 'one', sequence: 1, start_ms: 1000, end_ms: 4500, text: '先完成会议记录和行动项的关联，再安排本周的体验测试。', language: 'zh' },
      { id: 'two', sequence: 2, start_ms: 6000, end_ms: 11000, text: 'Please retain the original recording while we review the confirmed transcript.', language: 'en' },
    ] } })
    return route.fulfill({ json: { available: true, live_available: true, active_job_id: null, results: job ? [job] : [] } })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/live-capture-harness`)
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
    const { CaptureTranscriptionPanel } = await import('/src/features/meetings/components/CaptureTranscriptionPanel.tsx')
    window.liveCaptureClient = new QueryClient()
    createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.liveCaptureClient }, React.createElement(CaptureTranscriptionPanel, { viewerId: 'viewer', capture: { id: 'capture', record_id: 'record', status: 'recording', media_status: 'uploading' }, onSource: () => { throw new Error('Live preview must not play audio') }, includeSummary: false }))))
  })
  await page.getByRole('button', { name: '开启实时转写', exact: true }).waitFor()
  assert.equal(posts, 0)
  await page.getByRole('button', { name: '开启实时转写', exact: true }).click()
  await page.getByText('先完成会议记录和行动项的关联，再安排本周的体验测试。', { exact: true }).waitFor()
  assert.equal(posts, 1)
  await page.screenshot({ path: 'test-results/live-capture-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/live-capture-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '取消转写', exact: true }).click()
  await page.evaluate(() => window.liveCaptureClient.invalidateQueries())
  await page.getByText('本次转写未完整结束，以下仅保留已收到的文字。原始录音仍可独立保存或重新转写。', { exact: true }).waitFor()
  assert.equal(posts, 2)
  denied = true
  await page.evaluate(() => window.liveCaptureClient.invalidateQueries())
  await page.getByText('暂时无法读取或操作此转写，可能是连接中断或权限已变化。', { exact: true }).waitFor()
  assert.equal(await page.getByText('先完成会议记录和行动项的关联，再安排本周的体验测试。', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('Live capture UI passed: explicit start, confirmed preview, independent cancellation, desktop/mobile, permission revocation. All HTTP intercepted.')
} finally { await browser.close() }
