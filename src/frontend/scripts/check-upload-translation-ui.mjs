// Read-only fixtures: exercises real layout without opening a user's recording.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const job = {
  id: 'translation',
  record_id: 'record',
  target: 'en',
  status: 'succeeded',
  stale: false,
  input_revision: 1,
  completed_chunks: 1,
  total_chunks: 1,
}
const rows = [
  {
    segment_id: 'one',
    start_ms: 0,
    end_ms: 2000,
    speaker_name: 'Unknown',
    text: '对吧，我们把它看作一个大苹果，好吧？',
    translated_text: "Right, let's view it as one big apple, okay?",
  },
  {
    segment_id: 'two',
    start_ms: 2200,
    end_ms: 5000,
    speaker_name: 'Unknown',
    text: '对吧，那么这个里边也有X平方Y，是吧？',
    translated_text: 'Right, so this one also contains X squared Y, correct?',
  },
  {
    segment_id: 'three',
    start_ms: 5200,
    end_ms: 9000,
    speaker_name: 'Unknown',
    text: '那么这儿我就可以看成这样的，我有3个大苹果，再加上5个大苹果，总共加起来是几个？',
    translated_text:
      'Then I can see it like this: three big apples plus five big apples. How many are there in total?',
  },
]
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1100, height: 900 },
  })
  await context.route('**/translation-layout-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Translation layout</title><main style="max-width:1000px;margin:auto;padding:16px"><h1>课堂教学 · 译文</h1><div id="root"></div></main></html>',
    })
  )
  await context.route('**/api/v1.0/**', (route) => {
    assert.equal(route.request().method(), 'GET')
    assert.ok(
      route
        .request()
        .url()
        .includes('/meeting-records/record/upload-translations/')
    )
    return route.fulfill({
      json: route.request().url().includes('?page=')
        ? { ...job, results: rows, next_page: null }
        : { can_generate: true, revision: 1, results: [job] },
    })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mount = async () => {
    await page.goto(`${origin}/translation-layout-harness`)
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
      const { UploadTranslationPanel } =
        await import('/src/features/meetings/components/UploadTranslationPanel.tsx')
      function Preview() {
        const [positionMs, setPosition] = React.useState(2500)
        window.setTranslationPosition = setPosition
        return React.createElement(UploadTranslationPanel, {
          viewerId: 'layout-test',
          recordId: 'record',
          positionMs,
          onSource: (ms) => {
            window.translationSeek = ms
            setPosition(ms)
          },
        })
      }
      createRoot(document.getElementById('root')).render(
        React.createElement(
          React.Suspense,
          { fallback: 'Loading' },
          React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(Preview)
          )
        )
      )
    })
    await page.getByText(rows[0].translated_text, { exact: true }).waitFor()
  }
  await mount()
  mkdirSync('test-results', { recursive: true })
  await expect(page.locator('article[aria-current=true]')).toContainText(
    rows[1].translated_text
  )
  await page.getByRole('button', { name: '回听此段 0:00', exact: true }).click()
  assert.equal(await page.evaluate(() => window.translationSeek), 0)
  await page.evaluate(() => window.setTranslationPosition(2100))
  await expect(page.locator('article[aria-current=true]')).toHaveCount(0)
  await page.evaluate(() => window.setTranslationPosition(2500))
  await page.screenshot({
    path: 'test-results/translation-list-desktop.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: '左右对照', exact: true }).click()
  const columns = () =>
    page
      .locator('[data-compare]')
      .first()
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length
      )
  await expect.poll(columns).toBe(2)
  await page.screenshot({
    path: 'test-results/translation-list-comparison.png',
    fullPage: true,
  })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(
      page.getByRole('button', { name: '左右对照', exact: true })
    ).toBeHidden()
    await expect.poll(columns).toBe(1)
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    )
    await page.screenshot({
      path: `test-results/translation-list-${width}.png`,
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: '显示原文', exact: true }).click()
  await expect(page.getByText(rows[0].text, { exact: true })).toHaveCount(0)
  await mount()
  await expect(
    page.getByRole('button', { name: '显示原文', exact: true })
  ).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: '翻译说明', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('AI')
  assert.deepEqual(errors, [])
  console.log(
    'Translation layout passed: responsive columns, 320/390px, source visibility persistence, timestamps, playback gaps and explanation.'
  )
} finally {
  await browser.close()
}
