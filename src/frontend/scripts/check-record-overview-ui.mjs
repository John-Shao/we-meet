// Local fixtures only: verify the recording digest and standalone minutes surfaces.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const calls = []
let denied = false
let overviewResult = null
let overviewJob = null
let overviewPosts = 0
let outputLanguage = 'auto'
let languageWrites = 0
const overviewText = '这段录音围绕企业管理思维展开，介绍了结果导向与过程监督两种方式，以及它们对员工自主性的不同看法。'
const reference = { segment_id: 'source', segment_revision: 1, start_ms: 1000, end_ms: 5000 }
const version = {
  id: 'version', stage: 'final', is_current: true, input_snapshot_id: 'snapshot',
  created_at: '2026-09-22T03:00:00Z', delivery_status: 'complete', asr_status: 'finished',
  content: {
    overview: '本次讨论介绍了两类企业管理思维，重点比较管理目标、员工自主性与双方关系。',
    chapters: [{ text: '以结果为导向的管理方式关注员工创造的价值，给予工作方式更多自主空间。', source_refs: [reference] }, { text: '以在岗监督为导向的管理方式更关注出勤与过程，双方对劳动价值的理解有所不同。', source_refs: [reference] }],
    decisions: [{ text: '下次评审继续讨论团队的协作方式。', source_refs: [reference] }],
    action_items: [], open_questions: [],
  },
}
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/overview-ui-harness*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Recording overview check</title><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div></html>' }))
  await context.route('**/api/v1.0/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    calls.push(path)
    if (request.method() === 'PATCH') {
      assert.ok(path.endsWith('/overview/'))
      assert.equal(request.postDataJSON().expected_output_language, outputLanguage)
      outputLanguage = request.postDataJSON().output_language
      languageWrites++
      return route.fulfill({ json: { output_language: outputLanguage } })
    }
    if (request.method() === 'POST') {
      assert.ok(path.endsWith('/overview-requests/'))
      assert.ok(request.headers()['idempotency-key'])
      assert.equal(request.postDataJSON().operation, 'generate')
      overviewPosts++
      overviewResult = {
        id: 'overview', created_at: version.created_at, is_current: true, asr_status: 'finished', input_snapshot_id: 'snapshot', input_revision: 1,
        content: { synopsis: overviewText, topics: version.content.chapters.map((point, index) => ({ ...point, title: `观点 ${index + 1}` })) },
      }
      overviewJob = {
        id: '22222222-2222-4222-8222-222222222222', status: 'succeeded', attempt: 1, generation: 1, input_revision: 1,
        updated_at: version.created_at, retryable: false, dispatch_pending: false, error_code: '',
      }
      return route.fulfill({ status: 202, json: { request_id: '11111111-1111-4111-8111-111111111111', replayed: false, dispatch_state: 'sent', job: overviewJob } })
    }
    assert.equal(request.method(), 'GET')
    if (denied) return route.fulfill({ status: 403, json: {} })
    const reply = json => route.fulfill({ json })
    if (path.endsWith('/overview/')) return reply({ revision: 1, available: true, can_generate: true, generation_ready: true, output_language: outputLanguage, job: overviewJob, version: overviewResult })
    if (path.endsWith('/summary-versions/')) return reply({ results: [version], next_cursor: null })
    if (path.endsWith('/summary-job/')) return reply({ revision: 1, generation_ready: false, job: null })
    if (path.endsWith('/summary-automation/')) return reply({ available: false })
    if (path.endsWith('/human-summary/')) return reply({ current: null, can_edit: false })
    if (path.endsWith('/questions/')) return reply({ available: false, results: [] })
    if (path.endsWith('/document-exports/')) return reply({ available: false, results: [] })
    if (path.endsWith('/summary-sharing/')) return reply({ available: false, can_manage: false, results: [] })
    if (path.includes('/summary-notifications')) return reply({ results: [] })
    if (path.endsWith('/record/')) return reply({ id: 'record', title: '企业管理思维分享', owner: '会议创建者', source_type: 'upload', origin_at: '2026-09-22T03:00:00Z', revision: 1, capabilities: { read_summary: true, read_transcript: true, play_media: false } })
    return route.fulfill({ status: 404, json: {} })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const mount = async tab => {
    await page.goto(`${origin}/overview-ui-harness?tab=${tab}`)
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
      window.overviewClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.overviewClient }, React.createElement(RecordWorkspace, { viewerId: 'viewer', recordId: 'record' }))))
    })
  }
  await mount('overview')
  await page.getByRole('tab', { name: '概要', exact: true }).waitFor()
  assert.equal(overviewPosts, 0)
  await page.getByRole('button', { name: '生成概要', exact: true }).click()
  await page.getByText(overviewText, { exact: true }).waitFor()
  assert.equal(await page.getByText(version.content.overview, { exact: true }).count(), 0)
  assert.equal(overviewPosts, 1)
  assert.equal(await page.getByText(version.content.decisions[0].text).count(), 0)
  assert.equal(await page.getByRole('group', { name: '纪要工具' }).count(), 0)
  assert.ok(calls.every(path => /\/(record|overview|overview-requests)\/$/.test(path)))
  assert.equal(await page.getByRole('link', { name: '打开智能纪要' }).getAttribute('href'), '/meeting/records/record?tab=summary')
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '生成语言', exact: true }).click()
  await page.getByRole('combobox', { name: '生成语言', exact: true }).selectOption('en')
  await page.waitForFunction(() => document.querySelector('select')?.value === 'en')
  assert.equal(languageWrites, 1)
  assert.equal(overviewPosts, 1)
  await page.getByText(overviewText, { exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/record-overview-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/record-overview-mobile.png', fullPage: true })
  await page.getByRole('link', { name: '打开智能纪要' }).click()
  await page.getByRole('heading', { name: '智能纪要：企业管理思维分享', level: 2 }).waitFor()
  await page.getByText(version.content.decisions[0].text, { exact: true }).waitFor()
  assert.equal(await page.getByRole('tablist').count(), 0)
  await page.getByRole('group', { name: '纪要工具' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/record-minutes-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.screenshot({ path: 'test-results/record-minutes-desktop.png', fullPage: true })
  denied = true
  await page.evaluate(() => window.overviewClient.invalidateQueries())
  await page.getByText(version.content.overview, { exact: true }).waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('heading', { name: '智能纪要：企业管理思维分享', exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  assert.equal(overviewPosts, 1)
  console.log('Independent overview UI passed: explicit generation, separate endpoint and result, minutes navigation, desktop/mobile layout and revoked access. All HTTP intercepted.')
} finally { await browser.close() }
