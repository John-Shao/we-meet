import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const origin = process.env.APPS_UI_ORIGIN || 'http://127.0.0.1:3207'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
})
await context.route('**/apps*', (route) =>
  route.request().resourceType() === 'document'
    ? route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
      })
    : route.continue()
)
await context.route('**/api/v1.0/**', (route) =>
  route.fulfill({ json: { results: [], count: 0, next: null } })
)
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
async function mount() {
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    const { mountAppsHarness } =
      await import('/scripts/apps-navigation-harness.tsx')
    await mountAppsHarness()
  })
  await page.getByRole('heading', { name: '应用', exact: true }).waitFor()
}
try {
  await mkdir('test-results/apps-navigation', { recursive: true })
  await page.goto(`${origin}/apps`)
  await mount()
  assert.equal(await page.locator('[data-testid^="rail-/"]').count(), 5)
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-desktop-light.png',
  })
  await page.getByRole('button', { name: '添加常用', exact: true }).click()
  await page.getByRole('button', { name: '添加通讯录', exact: true }).click()
  await page.getByRole('button', { name: '添加沟通准备', exact: true }).click()
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-add-light.png',
  })
  await page.getByRole('button', { name: '管理常用', exact: true }).click()
  await page
    .getByRole('button', { name: '拖动沟通准备排序', exact: true })
    .dragTo(page.locator('[data-app-id="calendar"]'))
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('we-meet:apps:v1:apps-ui-fixture'))
        .favorites[0] === 'communication'
  )
  const shortcuts = await page
    .locator('[data-testid^="rail-shortcut-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid'))
    )
  assert.equal(shortcuts[0], 'rail-shortcut-communication')
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-manage-light.png',
  })
  await page.getByRole('button', { name: '移除任务', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.getByRole('button', { name: '添加任务', exact: true }).click()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.reload()
  await mount()
  assert.deepEqual(
    await page
      .locator('[data-testid^="favorite-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-testid'))
      ),
    [
      'favorite-communication',
      'favorite-calendar',
      'favorite-approval',
      'favorite-contacts',
      'favorite-tasks',
    ]
  )
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click()
  assert.equal(await page.locator('[data-testid^="catalog-"]').count(), 3)
  await page.getByRole('searchbox').fill('表格')
  assert.equal(await page.locator('[data-testid^="catalog-"]').count(), 1)
  await page.getByRole('searchbox').fill('')
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark')
  )
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-desktop-dark.png',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.renderAppsHarness())
  await page.getByRole('button', { name: '添加常用', exact: true }).click()
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-mobile-dark.png',
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  await page.getByRole('button', { name: '管理常用', exact: true }).click()
  await page.screenshot({
    path: 'test-results/apps-navigation/apps-mobile-manage-dark.png',
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  assert.equal(
    await page
      .locator('[data-app-id] h3')
      .evaluateAll((nodes) =>
        nodes.every((node) => node.getBoundingClientRect().height < 60)
      ),
    true
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS: five destinations, add/remove, mouse drag, rail sync, reload, categories, search, light/dark and narrow layouts'
  )
} finally {
  await browser.close()
}
