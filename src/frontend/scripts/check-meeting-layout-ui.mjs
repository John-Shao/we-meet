// Real browser layout/interaction checks; fixture GETs only, no account or microphone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'
const labels = JSON.parse(readFileSync('src/locales/zh/meetings.json', 'utf8'))
const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch()
const errors = []
const queries = []
const records = Array.from({ length: 30 }, (_, i) => ({
  id: `record-${i}`,
  title: `${i}: 课堂教学与项目评审的长标题 ${'meeting-'.repeat(8)}`,
  source_type: 'audio_recording',
  origin_at: '2026-09-20T00:00:00Z',
  has_summary: true,
  owner: 'Owner',
  capabilities: { read_transcript: true, read_summary: true },
}))
try {
  const page = await browser.newPage({ locale: 'zh-CN' })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/meeting-layout-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><meta charset="utf-8"><div id="root"></div></html>',
    })
  )
  await page.route('**/api/v1.0/**', (route) => {
    assert.equal(route.request().method(), 'GET')
    const url = new URL(route.request().url())
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/config/'))
      return reply({
        meeting_records: { enabled: true, capture_audio_enabled: true },
        search_ai: { enabled: true },
        feedback: {},
        background_image: {},
      })
    if (url.pathname.endsWith('/users/me'))
      return reply({
        id: 'owner',
        email: 'fixture@example.com',
        full_name: 'Owner',
      })
    if (url.pathname.endsWith('/recording-uploads/'))
      return reply({
        available: true,
        extensions: ['mp3', 'mp4'],
        max_bytes: 500000000,
      })
    if (url.pathname.endsWith('/meeting-records/')) {
      queries.push(url.search)
      return reply({
        results:
          url.searchParams.has('q') ||
          url.searchParams.get('is_ongoing') === 'true'
            ? []
            : records,
        next_cursor: null,
        supported_filters: ['created_from', 'created_before'],
      })
    }
    return reply(records[0])
  })
  const mount = async (kind, width, height = 844) => {
    await page.setViewportSize({ width, height })
    await page.goto(`${origin}/meeting-layout-harness`)
    await page.evaluate(async (kind) => {
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
      const modules = {
        records: ['MeetingLibrary', 'Library'],
        minutes: ['MeetingLibrary', 'Library'],
        recording: ['RecordingOverview', 'RecordingOverview'],
        capture: ['AudioRecording', 'Recorder'],
        detail: ['RecordingDetail', 'RecordingDetailContent'],
      }
      const [file, name] = modules[kind]
      const Component = (
        await import(`/src/features/meetings/routes/${file}.tsx`)
      )[name]
      const child = React.createElement(Component, {
        viewerId: 'owner',
        minutes: kind === 'minutes',
        available: false,
        recordId: 'record-0',
        page: true,
      })
      createRoot(document.getElementById('root')).render(
        React.createElement(
          React.Suspense,
          { fallback: 'Loading' },
          React.createElement(
            QueryClientProvider,
            {
              client: new QueryClient({
                defaultOptions: { queries: { retry: false } },
              }),
            },
            child
          )
        )
      )
    }, kind)
  }
  const noOverflow = async () =>
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    )
  for (const kind of ['records', 'minutes', 'recording']) {
    for (const width of [1440, 768, 390, 320]) {
      await mount(kind, width, width === 320 ? 640 : 844)
      const list = page.getByTestId('meeting-list-region')
      await list.getByRole('link').first().waitFor()
      await noOverflow()
      const height = (await list.boundingBox()).height
      assert.ok(height > 200, `${kind} ${width}: insufficient list space`)
      const headingY = (await page.locator('main h1').boundingBox()).y
      await list.evaluate((el) => {
        el.scrollTop = 500
      })
      assert.equal((await page.locator('main h1').boundingBox()).y, headingY)
      if (kind !== 'recording') {
        const trigger = page.getByRole('button', {
          name: labels.library.filters,
          exact: true,
        })
        await trigger.click()
        const dialog = page.getByRole('dialog', {
          name: labels.library.filters,
        })
        await expect(dialog).toBeVisible()
        assert.equal((await list.boundingBox()).height, height)
        await dialog
          .getByLabel(labels.library.sourceLabel)
          .selectOption('upload')
        const before = queries.length
        await page.keyboard.press('Escape')
        await expect(trigger).toBeFocused()
        assert.equal(queries.length, before)
        await trigger.click()
        await expect(dialog.getByLabel(labels.library.sourceLabel)).toHaveValue(
          ''
        )
        await dialog.getByLabel(labels.library.createdFrom).fill('2026-09-22')
        await dialog
          .getByLabel(labels.library.createdThrough)
          .fill('2026-09-20')
        await dialog
          .getByRole('button', { name: labels.library.applyFilters })
          .click()
        await expect(dialog.getByRole('alert')).toBeVisible()
        await noOverflow()
        await page.screenshot({
          path: `test-results/layout-${kind}-${width}-filters.png`,
        })
        await dialog
          .getByRole('button', { name: labels.library.resetFilters })
          .click()
        await dialog
          .getByRole('button', { name: labels.library.applyFilters })
          .click()
        await page.getByRole('searchbox').fill('no-match')
        await page.getByRole('searchbox').press('Enter')
        await expect(
          page.getByText(labels.library.noResults, { exact: true })
        ).toBeVisible()
        await list
          .getByRole('button', { name: labels.library.resetFilters })
          .click()
        await list.getByRole('link').first().waitFor()
      }
      await page.screenshot({
        path: `test-results/layout-${kind}-${width}.png`,
      })
    }
  }
  // Recording entry and detail previously retained a 260px sidebar on phones.
  for (const kind of ['capture', 'detail']) {
    await mount(kind, 320, 640)
    await page.getByRole('heading', { level: 1 }).waitFor()
    await noOverflow()
    assert.ok(
      (await page.getByRole('heading', { level: 1 }).boundingBox()).width > 0
    )
    await page.screenshot({ path: `test-results/layout-${kind}-320.png` })
  }
  await mount('minutes', 390)
  await page
    .getByTestId('meeting-list-region')
    .getByRole('link')
    .first()
    .waitFor()
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.fontSize = '200%'
  })
  await noOverflow()
  await page.screenshot({ path: 'test-results/layout-minutes-dark-200.png' })
  assert.deepEqual(errors, [])
  console.log(
    'Meeting layout checked: three modules, 320/390/768/1440px, fixed headers, filter cancel/apply/validation, search recovery, recording subpages, dark theme and 200% text.'
  )
} finally {
  await browser.close()
}
