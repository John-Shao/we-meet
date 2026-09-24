// Real Chromium, fixture HTTP, no model calls or account/device recording state.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const record = {
  id: 'cloud-record',
  title: '产品设计评审',
  source_type: 'audio_recording',
  capture_id: 'cloud-capture',
  origin_at: '2026-09-13T00:00:00Z',
  revision: 2,
  source_available: true,
  has_summary: true,
  is_ongoing: false,
  retention_mode: 'media',
  capabilities: {
    read_summary: true,
    read_transcript: true,
    generate_summary: false,
    rename: true,
  },
}
const source = {
  id: 'cloud-capture',
  record_id: record.id,
  status: 'stopped',
  media_status: 'saved',
  started_at: record.origin_at,
  captured_duration_ms: 2000,
  coverage_status: 'unverified',
}
const ref = {
  segment_id: 'original',
  segment_revision: 1,
  start_ms: 500,
  end_ms: 1000,
}
const audio = Buffer.alloc(64044)
audio.write('RIFF')
audio.writeUInt32LE(64036, 4)
audio.write('WAVEfmt ', 8)
audio.writeUInt32LE(16, 16)
audio.writeUInt16LE(1, 20)
audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(16000, 24)
audio.writeUInt32LE(32000, 28)
audio.writeUInt16LE(2, 32)
audio.writeUInt16LE(16, 34)
audio.write('data', 36)
audio.writeUInt32LE(64000, 40)
const chunk = {
  id: 'chunk',
  sequence: 1,
  start_ms: 0,
  duration_ms: 2000,
  stored: true,
  byte_size: audio.length,
  checksum: createHash('sha256').update(audio).digest('hex'),
}
let revoked = false
const requests = []
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1180, height: 900 },
  })
  await context.route('**/library-ui-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Library check</title><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/**', async (route) => {
    const url = new URL(route.request().url())
    requests.push({ path: url.pathname, method: route.request().method() })
    assert.equal(route.request().method(), 'GET')
    if (revoked) return route.fulfill({ status: 404, json: {} })
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/meeting-records/')) {
      if (url.searchParams.get('is_ongoing') === 'true')
        return reply({
          results: [
            {
              ...record,
              id: 'paused',
              title: '进行中的访谈',
              is_ongoing: true,
            },
          ],
          next_cursor: null,
        })
      return reply({ results: [record], next_cursor: null })
    }
    if (url.pathname.endsWith('/audio/'))
      return reply({
        results: [chunk],
        next_after_sequence: null,
        manifest: {
          final_sequence: 1,
          outcome: 'saved',
          duration_ms: 2000,
          gaps: [],
          missing_sequences: [],
          coverage_status: 'unverified',
        },
      })
    if (url.pathname.endsWith('/audio/chunk/'))
      return route.fulfill({ contentType: 'audio/wav', body: audio })
    if (url.pathname.endsWith('/transcription/'))
      return reply({
        available: true,
        active_job_id: 'asr',
        results: [
          {
            id: 'asr',
            generation: 1,
            status: 'succeeded',
            input_count: 1,
            acknowledged_inputs: 1,
            final_count: 1,
          },
        ],
      })
    if (url.pathname.includes('/capture-sessions/')) return reply(source)
    if (url.pathname.endsWith('/original-segments/'))
      return reply({
        results: [
          {
            id: 'original',
            start_ms: 500,
            text: '本周先完成录音和纪要的统一入口。',
          },
        ],
        next_cursor: null,
      })
    if (url.pathname.endsWith('/speakers/'))
      return reply({
        results: [
          { id: 'speaker', label: 'Unknown speaker', identity_type: 'unknown' },
        ],
        next_cursor: null,
      })
    if (url.pathname.endsWith('/summary-job/'))
      return reply({ revision: 2, generation_ready: false, job: null })
    if (url.pathname.endsWith('/summary-versions/'))
      return reply({
        next_cursor: null,
        results: [
          {
            id: 'version',
            stage: 'final',
            created_at: record.origin_at,
            is_current: true,
            input_snapshot_id: 'snapshot',
            delivery_status: 'complete',
            asr_status: 'finished',
            coverage_status: 'unverified',
            content: {
              overview: '统一会议资料入口，便于团队找回录音与纪要。',
              decisions: [{ text: '先完成统一资料库。', source_refs: [ref] }],
              chapters: [],
              action_items: [],
              open_questions: [],
            },
          },
        ],
      })
    if (url.pathname.includes('/transcript-versions/'))
      return reply({
        id: 'snapshot',
        revision: 2,
        segments: [{ ...ref, text: '本周先完成录音和纪要的统一入口。' }],
      })
    if (url.pathname.endsWith('/summary-automation/'))
      return reply({ available: false, can_control: false, enabled: false })
    if (url.pathname.endsWith('/human-summary/'))
      return reply({ current: null, can_edit: false })
    if (url.pathname.endsWith('/questions/'))
      return reply({ available: false, recent: [] })
    return reply(record)
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(error.message))
  await page.goto(`${origin}/library-ui-harness`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { QueryClient, QueryClientProvider } =
      await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    const { Route, Switch } = await import('/node_modules/.vite/deps/wouter.js')
    const { Library } =
      await import('/src/features/meetings/routes/MeetingLibrary.tsx')
    const { RecordWorkspace } =
      await import('/src/features/meetings/routes/MeetingRecordWorkspace.tsx')
    window.history.replaceState(null, '', '/meeting/notes?source_type=upload')
    window.libraryClient = new QueryClient()
    createRoot(document.getElementById('root')).render(
      React.createElement(
        React.Suspense,
        { fallback: 'Loading…' },
        React.createElement(
          QueryClientProvider,
          { client: window.libraryClient },
          React.createElement(
            Switch,
            null,
            React.createElement(
              Route,
              { path: '/meeting/records/:recordId' },
              (params) =>
                React.createElement(RecordWorkspace, {
                  viewerId: 'owner',
                  recordId: params.recordId,
                })
            ),
            React.createElement(
              Route,
              null,
              React.createElement(Library, {
                viewerId: 'owner',
                captureEnabled: true,
              })
            )
          )
        )
      )
    )
  })
  await page.getByRole('link', { name: record.title }).waitFor()
  await page.getByRole('link', { name: record.title }).click()
  const header = page.locator('main > div > header').first()
  await header.locator('h1').filter({ hasText: record.title }).waitFor()
  const parent = header.locator('nav a')
  assert.equal(
    await parent.getAttribute('href'),
    '/meeting/notes?source_type=upload'
  )
  const actions = header.locator(':scope > div button')
  assert.equal(await actions.count(), 2)
  const boxes = await Promise.all([
    parent.boundingBox(),
    header.locator('h1').boundingBox(),
    actions.first().boundingBox(),
    actions.last().boundingBox(),
  ])
  assert.ok(
    boxes[0].x < boxes[1].x &&
      boxes[1].x < boxes[2].x &&
      boxes[2].x < boxes[3].x
  )
  assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 2)
  await page.screenshot({
    path: 'test-results/meeting-detail-header-desktop.png',
    fullPage: true,
  })
  const longTitle = record.title.repeat(30)
  await page.evaluate(async (title) => {
    window.libraryClient.setQueriesData(
      { queryKey: ['meeting-records', 'owner'] },
      (old) => (old?.id ? { ...old, title } : old)
    )
  }, longTitle)
  await header.locator('h1').filter({ hasText: longTitle }).waitFor()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    )
    assert.equal(
      await header
        .locator('h1')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      true
    )
    await parent.focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await header
        .locator('h1')
        .evaluate((el) => getComputedStyle(el).whiteSpace),
      'normal'
    )
    await header.locator('h1').evaluate((el) => el.blur())
    await header.locator('nav button').click()
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    )
    await header.locator('form button').last().click()
    await page.screenshot({
      path: `test-results/meeting-detail-header-${width}.png`,
      fullPage: true,
    })
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.screenshot({
    path: 'test-results/meeting-detail-header-dark.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 640, height: 844 })
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await page.evaluate(() => {
    document.documentElement.style.fontSize = ''
  })
  await parent.click()
  await page.getByRole('link', { name: record.title }).waitFor()
  assert.equal(new URL(page.url()).search, '?source_type=upload')
  console.log(
    'Meeting detail header passed: desktop hierarchy, actions, return URL, long title, keyboard, 390/320px, rename form, dark theme. Fixtures only.'
  )
} finally {
  await browser.close()
}
