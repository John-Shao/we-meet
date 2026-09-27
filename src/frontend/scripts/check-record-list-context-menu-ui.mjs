import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'

// Fixture-only browser check: no account data or server writes.
const copy = JSON.parse(readFileSync('src/locales/zh/meetings.json', 'utf8'))
const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
const record = {
  id: 'record',
  title: 'Context menu fixture',
  source_type: 'audio_recording',
  origin_at: '2026-09-27T00:00:00Z',
  has_summary: true,
  lifecycle_revision: 1,
  capabilities: { rename: true, trash: true },
}
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      locale: 'zh-CN',
      hasTouch: touch,
      isMobile: touch,
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1180, height: 900 },
    })
    await context.route('**/list-menu-harness', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>List menu</title><div id="root"></div></html>',
      })
    )
    await context.route('**/api/v1.0/**', (route) => {
      assert.equal(route.request().method(), 'GET')
      const url = new URL(route.request().url())
      return route.fulfill({
        json: url.pathname.endsWith('/meeting-records/')
          ? {
              results:
                url.searchParams.get('is_ongoing') === 'true' ? [] : [record],
              next_cursor: null,
            }
          : {},
      })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const minutes of [false, true]) {
      await page.goto(`${origin}/list-menu-harness`)
      await page.evaluate(async (minutes) => {
        const runtime = (await import('/@react-refresh')).default
        runtime.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => undefined
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
        await import('/src/styles/index.css')
        await import('/src/i18n/init.ts')
        const React = (await import('/node_modules/.vite/deps/react.js'))
          .default
        const { createRoot } = (
          await import('/node_modules/.vite/deps/react-dom_client.js')
        ).default
        const { QueryClient, QueryClientProvider } =
          await import('/node_modules/.vite/deps/@tanstack_react-query.js')
        const { Library } =
          await import('/src/features/meetings/routes/MeetingLibrary.tsx')
        createRoot(document.getElementById('root')).render(
          React.createElement(
            React.Suspense,
            { fallback: 'Loading' },
            React.createElement(
              QueryClientProvider,
              { client: new QueryClient() },
              React.createElement(Library, { viewerId: 'owner', minutes })
            )
          )
        )
      }, minutes)
      const link = page.getByRole('link', { name: record.title })
      await expect(link).toHaveAttribute(
        'href',
        `/meeting/records/record${minutes ? '?tab=summary' : ''}`
      )
      const row = link.locator('xpath=ancestor::*[@data-record-row][1]')
      const more = row.getByRole('button')
      const wrap = more.locator('..')
      if (touch) {
        await expect(wrap).toHaveCSS('opacity', '1')
        await more.tap()
      } else {
        await page.mouse.move(0, 0)
        await expect(wrap).toHaveCSS('opacity', '0')
        await row.hover()
        await expect(wrap).toHaveCSS('opacity', '1')
        await more.click()
      }
      await expect(page.getByRole('menu')).toBeVisible()
      await page.screenshot({
        path: `test-results/record-menu-${minutes ? 'minutes' : 'records'}-${touch ? 'touch' : 'desktop'}.png`,
      })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(more).toBeFocused()
      if (!touch) {
        await link.click({ button: 'right' })
        await expect(page.getByRole('menu')).toBeVisible()
        await page.keyboard.press('Escape')
        await page
          .getByRole('button', { name: copy.library.gridView, exact: true })
          .click()
        await link.click({ button: 'right' })
        await expect(page.getByRole('menu')).toBeVisible()
        await page.screenshot({
          path: `test-results/record-menu-grid-${minutes}.png`,
        })
        await page.keyboard.press('Escape')
        await page
          .getByRole('button', { name: copy.library.listView, exact: true })
          .click()
      }
      // Force a lower-right anchor to verify clamping rather than natural placement.
      await link.dispatchEvent('contextmenu', {
        clientX: touch ? 385 : 1175,
        clientY: touch ? 839 : 895,
      })
      const box = await page.getByRole('menu').boundingBox()
      const viewport = page.viewportSize()
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height
      )
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        ),
        true
      )
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(
    'PASS: both libraries, table/grid, hover/focus, touch access, right-click and viewport clamping'
  )
} finally {
  await browser.close()
}
