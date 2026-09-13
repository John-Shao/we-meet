// Native Chromium with isolated HTTP fixtures. No capture, model or notification is sent.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
let stage = 'realtime', enabled = false, revision = 0, denied = false
const posts = []
const sourceRef = { segment_id: 'source', segment_revision: 1, start_ms: 1000, end_ms: 5000 }
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/live-summary-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Live summary</title><main style="max-width:760px;padding:16px;margin:auto"><h1>项目评审 · AI 录音</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/v1.0/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const reply = json => route.fulfill({ json })
    if (denied) return route.fulfill({ status: 403, json: {} })
    if (request.method() === 'POST') {
      assert.ok(path.endsWith('/summary-automation/'))
      const body = request.postDataJSON()
      assert.equal(body.expected_revision, revision)
      assert.ok(request.headers()['idempotency-key'])
      posts.push({ path, body })
      enabled = body.enabled
      revision++
      return reply({ current: { enabled, revision } })
    }
    if (path.endsWith('/transcription/')) return reply({ available: true, live_available: true, summary_available: true, staged_summary_available: true,
      active_job_id: stage === 'final' ? 'asr' : null, results: [{ id: 'asr', mode: 'live', generation: 1, status: stage === 'final' ? 'succeeded' : 'running', input_count: 2, acknowledged_inputs: 2, final_count: 1 }] })
    if (path.includes('/preview/')) return reply({ job_id: 'asr', status: 'running', published: false, last_sequence: 1, next_after_sequence: null,
      results: [{ id: 'source', sequence: 1, start_ms: 1000, end_ms: 5000, text: '先完成任务关联，再安排体验测试。', language: 'zh' }] })
    if (path.endsWith('/summary-automation/')) return reply({ available: true, can_control: true, enabled, revision, state: enabled ? 'waiting' : 'off', error_code: '' })
    if (path.endsWith('/summary-job/')) return reply({ revision: 2, staged_summaries_enabled: true, generation_ready: stage === 'final', ready_stages: [],
      job: revision ? { id: stage, stage, status: 'partial', attempt: 1 } : null })
    if (path.endsWith('/summary-versions/')) return reply({ next_cursor: null, results: revision ? [{ id: stage, stage, created_at: '2026-09-13T03:00:00Z', input_snapshot_id: 'snapshot', is_current: true,
      source_through_ms: 5000, delivery_status: stage === 'final' ? 'complete' : 'open', asr_status: stage === 'final' ? 'finished' : 'in_progress',
      content: { overview: '先打通会议与任务，再验证实际使用体验。', decisions: [{ text: '安排一轮体验测试。', source_refs: [sourceRef] }], chapters: [], action_items: [], open_questions: [] } }] : [] })
    if (path.includes('/transcript-versions/')) return reply({ id: 'snapshot', revision: 1, segments: [{ ...sourceRef, text: '先完成任务关联，再安排体验测试。' }] })
    if (path.endsWith('/original-segments/')) return reply({ results: [], next_cursor: null })
    if (path.endsWith('/human-summary/')) return reply({ current: null, can_edit: false })
    if (path.endsWith('/questions/')) return reply({ available: false, results: [] })
    if (path.endsWith('/document-exports/')) return reply({ available: false, results: [] })
    if (path.endsWith('/summary-sharing/')) {
      assert.equal(stage, 'final')
      return reply({ available: false, can_manage: false, results: [] })
    }
    if (path.includes('/summary-notifications')) return reply({ results: [] })
    if (path.endsWith('/record/')) return reply({ id: 'record', source_type: 'audio', title: '项目评审', origin_at: '2026-09-13T03:00:00Z', revision: 2, capabilities: { read_summary: true, read_transcript: true, generate_summary: true } })
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/live-summary-harness`)
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
    window.summaryClient = new QueryClient()
    window.playedSource = null
    const root = createRoot(document.getElementById('root'))
    window.renderCapture = status => root.render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.summaryClient },
      React.createElement(CaptureTranscriptionPanel, { viewerId: 'viewer', capture: { id: 'capture', record_id: 'record', status, media_status: status === 'stopped' ? 'saved' : 'uploading' }, onSource: time => { window.playedSource = time } }))))
    window.renderCapture('recording')
  })
  await page.getByText('实时总结', { exact: true }).click()
  await page.getByRole('button', { name: '开启自动总结', exact: true }).waitFor()
  assert.equal(posts.length, 0)
  await page.getByRole('button', { name: '开启自动总结', exact: true }).click()
  await page.getByText('先打通会议与任务，再验证实际使用体验。', { exact: true }).waitFor()
  await page.getByText('正在识别，尾段尚未收齐', { exact: true }).waitFor()
  assert.equal(await page.getByText(/recordAi\./).count(), 0)
  assert.equal(posts.length, 1)
  await page.getByRole('button', { name: /查看原文 0:01/ }).click()
  assert.equal(await page.getByRole('button', { name: '回听这段原音', exact: true }).count(), 0)
  await page.screenshot({ path: 'test-results/live-summary-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/live-summary-mobile.png', fullPage: true })
  stage = 'quick'
  await page.evaluate(() => { window.renderCapture('stopping'); return window.summaryClient.invalidateQueries() })
  await page.getByRole('heading', { name: /速记摘要/ }).waitFor()
  stage = 'final'
  await page.evaluate(() => { window.renderCapture('stopped'); return window.summaryClient.invalidateQueries() })
  await page.getByText('智能纪要与问答', { exact: true }).waitFor()
  await page.getByRole('heading', { name: /最终纪要/ }).waitFor()
  await page.getByRole('button', { name: '关闭自动总结', exact: true }).click()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body.enabled, false)
  denied = true
  await page.evaluate(() => window.summaryClient.invalidateQueries())
  await page.getByText('暂时无法读取或操作此转写，可能是连接中断或权限已变化。', { exact: true }).waitFor()
  assert.equal(await page.getByText('先打通会议与任务，再验证实际使用体验。', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('Live summary UI passed: explicit consent, realtime/quick/final transitions, citations, desktop/mobile and revoked access. All HTTP intercepted.')
} finally { await browser.close() }
