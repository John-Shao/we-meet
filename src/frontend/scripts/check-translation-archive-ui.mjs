// Intercepted read-only fixtures; never opens a real meeting or retained transcript.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const privateArchive = process.env.PRIVATE_TRANSLATION_ARCHIVE === '1'
const archiveInfo = privateArchive ? { source_kind: 'private', mode: 'push_to_talk', source: 'zh' } : { source_kind: 'channel' }
const lastText = privateArchive ? '请将关键决策和行动项关联到原始会议记录。' : 'Please keep the decisions and action items connected to the original meeting notes.'
const screenshotName = privateArchive ? 'private-translation-archive' : 'translation-archive'
const browser = await chromium.launch({ headless: true })
let denied = false
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 850 } })
  await context.route('**/translation-archive-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Retained translations</title><main style="max-width:760px;padding:16px;margin:auto"><h1>产品设计评审 · 译文</h1><div id="root"></div></main></html>' }))
  await context.route('**/api/v1.0/**', route => {
    assert.equal(route.request().method(), 'GET')
    assert.ok(route.request().url().includes('/meeting-records/record/translation-'))
    if (denied) return route.fulfill({ status: 403, json: {} })
    if (route.request().url().includes('translation-archives/')) return route.fulfill({ json: {
      results: [{ ...archiveInfo, id: 'archive', target: 'en', generation: 1, status: 'incomplete', segment_count: 2, created_at: '2026-09-13T00:00:00Z' }], next_cursor: null,
    } })
    return route.fulfill({ json: { ...archiveInfo, archive_id: 'archive', archive_status: 'incomplete', target: 'en', next_cursor: null, results: [
      { id: 'one', sequence: 1, target: 'en', text: 'We will finish the interface review this week. The release scope will be confirmed after the test results are available.', speaker_label: '产品负责人', received_at: '2026-09-13T00:00:10Z', timing_basis: 'delivery', original_id: null },
      { id: 'two', sequence: 2, target: privateArchive ? 'zh' : 'en', text: lastText, speaker_label: '设计负责人', received_at: '2026-09-13T00:00:20Z', timing_basis: 'delivery', original_id: null },
    ] } })
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/translation-archive-harness`)
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
    const { TranslationArchivePanel } = await import('/src/features/meetings/components/TranslationArchivePanel.tsx')
    window.translationArchiveClient = new QueryClient()
    createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading…' }, React.createElement(QueryClientProvider, { client: window.translationArchiveClient }, React.createElement(TranslationArchivePanel, { viewerId: 'viewer', recordId: 'record' }))))
  })
  await page.getByRole('button', { name: '查看英语第 1 次译文', exact: true }).click()
  await page.getByText('部分译文未能确认保存，以下仅展示已保存内容。', { exact: true }).waitFor()
  if (privateArchive) await page.getByText('私人译文，仅你可见', { exact: true }).waitFor()
  await page.screenshot({ path: `test-results/${screenshotName}-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: `test-results/${screenshotName}-mobile.png`, fullPage: true })
  denied = true
  await page.evaluate(() => window.translationArchiveClient.invalidateQueries())
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByText(lastText, { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('Translation archive UI passed: explicit selection, partial status, delivery-time explanation, desktop/mobile and permission revocation; only intercepted GETs.')
} finally { await browser.close() }
