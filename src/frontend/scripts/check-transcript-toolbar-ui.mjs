import { readFileSync } from 'node:fs'
// Real Chromium, fixture HTTP, no model calls or account/device recording state.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect } from '@playwright/test'

const labels = JSON.parse(readFileSync('src/locales/zh/meetings.json', 'utf8'))
const errors = []
let continuousFixture = false
let failNextPage = false
let nextRequests = 0
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
    batch_correct: true,
    play_media: true,
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
    assert.equal(route.request().method(), 'GET')
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/overview/'))
      return reply({
        revision: 2,
        available: true,
        can_generate: true,
        generation_ready: true,
        job: null,
        version: {
          id: 'overview',
          created_at: record.origin_at,
          input_snapshot_id: 'snapshot',
          input_revision: 2,
          is_current: true,
          asr_status: 'finished',
          content: {
            synopsis: 'Overview fixture',
            topics: Array.from({ length: 40 }, (_, i) => ({
              title: `Topic ${i}`,
              text: 'Detailed discussion '.repeat(12),
              source_refs: [ref],
            })),
          },
        },
      })
    if (url.pathname.endsWith('/document-exports/'))
      return reply({ results: [], next_cursor: null, available: true })
    if (url.pathname.endsWith('/upload-translations/'))
      return reply({
        can_generate: true,
        revision: 2,
        results: [
          {
            id: 'translation',
            record_id: record.id,
            target: 'en',
            status: 'succeeded',
            stale: false,
            input_revision: 2,
            completed_chunks: 1,
            total_chunks: 1,
          },
        ],
      })
    if (url.pathname.endsWith('/upload-translations/translation/'))
      return reply({
        id: 'translation',
        record_id: record.id,
        target: 'en',
        status: 'succeeded',
        stale: false,
        input_revision: 2,
        next_page: null,
        results: Array.from({ length: 40 }, (_, i) => ({
          segment_id: `translation-${i}`,
          start_ms: i * 1000,
          speaker_name: 'Speaker',
          text: `Original ${i}`,
          translated_text: `Translation ${i}`,
        })),
      })
    if (url.pathname.endsWith('/media/'))
      return reply({
        url: `${origin}/api/v1.0/fixture/audio/chunk/`,
        media_type: 'video',
        content_type: 'audio/wav',
        name: 'layout-fixture.wav',
        size: audio.length,
        expires_in: 3600,
      })
    if (url.pathname.endsWith('/transcript-replacements/'))
      return reply({ results: [] })
    if (url.pathname.endsWith('/original-segments/')) {
      const next =
        continuousFixture && url.searchParams.get('cursor') === 'next'
      if (next) {
        nextRequests++
        if (failNextPage)
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{}',
          })
      }
      return reply({
        results: Array.from({ length: 40 }, (_, offset) => {
          const index = offset + (next ? 40 : 0)
          return {
            id: `line-${index}`,
            start_ms: index * 1000,
            end_ms: index * 1000 + 900,
            text: `Meeting transcript ${index}: project review and meeting notes.`,
            can_correct: true,
            correction_revision: 1,
          }
        }),
        next_cursor: continuousFixture && !next ? 'next' : null,
      })
    }
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
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
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
  const toolbar = page.getByRole('group', {
    name: labels.transcriptToolbar.label,
  })
  const scroller = page.locator('[data-transcript-scroll]')
  const search = toolbar.getByRole('searchbox')
  await search.waitFor()
  await page
    .getByText('Meeting transcript 0: project review and meeting notes.', {
      exact: true,
    })
    .waitFor()
  const top = (await toolbar.boundingBox()).y
  assert.ok(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight))
  await scroller.evaluate((el) => {
    el.scrollTop = 1000
  })
  assert.equal((await toolbar.boundingBox()).y, top)
  assert.ok(
    (await scroller.boundingBox()).y >=
      (await toolbar.boundingBox()).y + (await toolbar.boundingBox()).height
  )
  await page.screenshot({
    path: 'test-results/transcript-toolbar-desktop.png',
    fullPage: true,
  })
  await toolbar
    .getByRole('button', { name: labels.transcriptExport.label })
    .click()
  for (const format of ['TXT', 'SRT', 'VTT']) {
    const link = page.getByRole('menuitem', {
      name: labels.transcriptExport.download.replace('{{format}}', format),
    })
    assert.ok(
      (await link.getAttribute('href')).includes(`?as=${format.toLowerCase()}`)
    )
    assert.notEqual(await link.getAttribute('download'), null)
  }
  await page.keyboard.press('Escape')
  await expect(
    toolbar.getByRole('button', { name: labels.transcriptExport.label })
  ).toBeFocused()
  await search.fill('meeting')
  await search.press('Enter')
  await page.waitForFunction(() =>
    document.querySelector('[data-transcript-scroll] mark')
  )
  await toolbar
    .getByRole('button', { name: labels.transcriptToolbar.nextMatch })
    .click()
  assert.equal(await page.locator('mark[data-search-current=true]').count(), 1)
  assert.ok((await toolbar.getByRole('status').innerText()).includes('1 / 80'))
  await toolbar
    .getByRole('button', { name: labels.transcriptToolbar.nextMatch })
    .click()
  assert.ok((await toolbar.getByRole('status').innerText()).includes('2 / 80'))
  await toolbar
    .getByRole('button', { name: labels.transcriptToolbar.previousMatch })
    .click()
  assert.ok((await toolbar.getByRole('status').innerText()).includes('1 / 80'))
  await toolbar
    .getByRole('button', { name: labels.batchCorrection.title })
    .click()
  await toolbar
    .getByRole('region', { name: labels.batchCorrection.title })
    .waitFor()
  assert.ok((await scroller.boundingBox()).height > 120)
  assert.equal(await search.inputValue(), 'meeting')
  await toolbar
    .getByRole('button', { name: labels.batchCorrection.close })
    .click()
  assert.equal(await search.inputValue(), 'meeting')
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    )
    await toolbar
      .getByRole('button', { name: labels.batchCorrection.title })
      .click()
    assert.ok((await scroller.boundingBox()).height > 100)
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    )
    await page.screenshot({
      path: `test-results/transcript-toolbar-${width}.png`,
      fullPage: true,
    })
    await toolbar
      .getByRole('button', { name: labels.batchCorrection.close })
      .click()
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.screenshot({
    path: 'test-results/transcript-toolbar-dark.png',
    fullPage: true,
  })
  // Owner capture path must fill the same toolbar without duplicate search fields.
  record.capabilities.control_capture = true
  await page.evaluate(() =>
    window.libraryClient.invalidateQueries({
      queryKey: ['meeting-records', 'owner'],
    })
  )
  await search.waitFor()
  await page.waitForFunction(
    () => !!document.querySelector('section[aria-label] h2')
  )
  assert.equal(await page.getByRole('searchbox').count(), 1)
  assert.equal(await toolbar.getByRole('searchbox').count(), 1)
  await search.fill('meeting')
  await search.press('Enter')
  await toolbar
    .getByRole('button', { name: labels.transcriptToolbar.nextMatch })
    .click()
  assert.equal(await page.locator('mark[data-search-current=true]').count(), 1)
  assert.deepEqual(errors, [])
  // Exercise the uploaded-video split layout with locally generated media bytes.
  record.source_type = 'upload'
  delete record.capture_id
  record.capabilities.control_capture = false
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.evaluate(() =>
    window.libraryClient.invalidateQueries({
      queryKey: ['meeting-records', 'owner'],
    })
  )
  await page.locator('[data-record-content][data-split=true]').waitFor()
  await search.waitFor()
  assert.ok((await toolbar.boundingBox()).width < 800)
  const splitTop = (await toolbar.boundingBox()).y
  await scroller.evaluate((el) => {
    el.scrollTop = 800
  })
  assert.equal((await toolbar.boundingBox()).y, splitTop)
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await page.screenshot({
    path: 'test-results/transcript-toolbar-video-split.png',
    fullPage: true,
  })
  assert.deepEqual(errors, [])
  record.capabilities.download_media = true
  record.capabilities.trash = true
  record.lifecycle_revision = 2
  await page.evaluate(() =>
    window.libraryClient.invalidateQueries({
      queryKey: ['meeting-records', 'owner'],
    })
  )
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of [
      labels.recordOverview.title,
      labels.recordAi.sections.chapters,
      labels.translationArchive.title,
      labels.library.info,
    ]) {
      await page.getByRole('tab', { name, exact: true }).click()
      const panel = page
        .getByRole('tabpanel')
        .filter({ has: page.locator('[data-record-toolbar]') })
        .filter({ has: page.getByRole('group', { name, exact: true }) })
      const tools = panel.locator('[data-record-toolbar]')
      const body = panel.locator('[data-record-scroll]')
      await expect(tools)
        .toBeVisible()
        .catch(async (error) => {
          await page.screenshot({
            path: 'test-results/record-tools-failure.png',
          })
          console.log(
            width,
            name,
            await page.locator('[role=tabpanel]').evaluateAll((els) =>
              els.map((el) => ({
                text: el.textContent.slice(0, 120),
                html: el.outerHTML.slice(0, 1300),
              }))
            )
          )
          throw error
        })
      if (
        name === labels.recordOverview.title ||
        name === labels.recordAi.sections.chapters
      )
        await panel.getByText('Topic 39', { exact: true }).waitFor()
      if (name === labels.translationArchive.title) {
        await panel.getByText('Translation 39', { exact: true }).waitFor()
        await tools
          .getByRole('button', { name: labels.uploadTranslation.export })
          .click()
        await expect(page.getByRole('menuitem').first()).toHaveAttribute(
          'href',
          /translation\/export\/\?as=txt/
        )
        await page.keyboard.press('Escape')
        await expect(
          tools.getByRole('button', { name: labels.uploadTranslation.export })
        ).toBeFocused()
      }
      const top = (await tools.boundingBox()).y
      await body.evaluate((el) => {
        el.scrollTop = 700
      })
      assert.equal((await tools.boundingBox()).y, top)
      assert.ok((await body.boundingBox()).height > 50)
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        ),
        true
      )
      await page.screenshot({
        path: `test-results/record-tools-${width}-${[labels.recordOverview.title, labels.recordAi.sections.chapters, labels.translationArchive.title, labels.library.info].indexOf(name)}.png`,
      })
      if (name === labels.library.info) {
        await expect(
          tools.getByRole('button', { name: labels.mediaDownload.action })
        ).toBeVisible()
        await expect(
          panel.getByText(labels.trash.remove, { exact: true })
        ).toHaveCount(0)
      }
    }
  }
  await page
    .getByRole('button', { name: labels.video.more, exact: true })
    .click()
  await page.getByRole('menuitem', { name: labels.trash.remove }).click()
  await expect(
    page.getByRole('dialog', { name: labels.trash.remove, exact: true })
  ).toBeVisible()
  await page
    .getByRole('dialog', { name: labels.trash.remove, exact: true })
    .getByRole('button', { name: labels.trash.cancel })
    .click()
  await page
    .getByRole('tab', { name: labels.recordOverview.title, exact: true })
    .click()
  const overviewScroll = page
    .getByRole('tabpanel')
    .locator('[data-record-scroll]')
  await expect
    .poll(() => overviewScroll.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100)
  await page
    .getByRole('tab', { name: labels.translationArchive.title, exact: true })
    .click()
  await page
    .getByRole('combobox', { name: labels.uploadTranslation.language })
    .selectOption('zh')
  await page
    .getByRole('tab', { name: labels.recordOverview.title, exact: true })
    .click()
  await page
    .getByRole('tab', { name: labels.translationArchive.title, exact: true })
    .click()
  await expect(
    page.getByRole('combobox', { name: labels.uploadTranslation.language })
  ).toHaveValue('zh')
  await page
    .getByRole('tab', { name: labels.library.text, exact: true })
    .click()
  await page.getByRole('searchbox').fill('retained search')
  await page.getByRole('searchbox').press('Enter')
  await page
    .getByRole('tab', { name: labels.recordOverview.title, exact: true })
    .click()
  await page
    .getByRole('tab', { name: labels.library.text, exact: true })
    .click()
  await expect(page.getByRole('searchbox')).toHaveValue('retained search')
  await page
    .getByRole('tab', { name: labels.recordOverview.title, exact: true })
    .click()
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.fontSize = '200%'
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await page.screenshot({ path: 'test-results/record-tools-dark-large.png' })
  // A second page must append automatically, survive a failed read, and retain position on refresh.
  continuousFixture = true
  failNextPage = true
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.style.fontSize = ''
  })
  await page
    .getByRole('tab', { name: labels.library.text, exact: true })
    .click()
  await search.fill('')
  await search.press('Enter')
  await toolbar
    .getByRole('button', { name: labels.library.refresh, exact: true })
    .click()
  await expect(
    toolbar.getByRole('button', { name: labels.library.refresh, exact: true })
  ).toBeEnabled()
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await scroller
    .getByRole('button', { name: labels.continuous.retry })
    .waitFor()
  await expect(scroller.locator('[data-segment-id="line-0"]')).toHaveCount(1)
  failNextPage = false
  await scroller.getByRole('button', { name: labels.continuous.retry }).click()
  await expect(scroller.locator('[data-segment-id="line-79"]')).toHaveCount(1)
  await expect(scroller.locator('[data-segment-id="line-0"]')).toHaveCount(1)
  assert.equal(nextRequests, 2)
  await scroller.locator('[data-segment-id="line-45"]').scrollIntoViewIfNeeded()
  const retainedTop = await scroller.evaluate((el) => el.scrollTop)
  await toolbar
    .getByRole('button', { name: labels.library.refresh, exact: true })
    .click()
  await expect(
    toolbar.getByRole('button', { name: labels.library.refresh, exact: true })
  ).toBeEnabled()
  assert.ok(
    Math.abs((await scroller.evaluate((el) => el.scrollTop)) - retainedTop) < 3
  )
  await page.screenshot({ path: 'test-results/record-continuous-reading.png' })
  assert.deepEqual(errors, [])
  console.log(
    'Record panel toolbars verified: fixed tools, scroll isolation, tab state restoration, search, translation export, trash cancellation, 320/390/1440px, dark 200% text and both transcript readers. Fixture GETs only.'
  )
} finally {
  await browser.close()
}
