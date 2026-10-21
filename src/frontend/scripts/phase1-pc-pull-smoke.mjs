import { chromium } from 'playwright'

const token = process.env.WE_MEET_ACCESS_TOKEN
const apiBase = process.env.WE_MEET_API_BASE || 'http://127.0.0.1:8071'
const appBase = 'http://127.0.0.1:4173'
if (!token) throw new Error('WE_MEET_ACCESS_TOKEN required')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext()
await context.addInitScript((value) => {
  localStorage.setItem('we-meet:access_token', value)
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
}, token)
const page = await context.newPage()
await context.route(`${appBase}/api/**`, async route => {
  const request = route.request()
  const response = await fetch(request.url().replace(appBase, apiBase), {
    method: request.method(),
    headers: request.headers(),
    body: request.postDataBuffer() ?? undefined,
  })
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  })
})
await page.goto(`${appBase}/ai-call`, { waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '通话记录' }).click()
await page.getByTestId('ai-call-history').waitFor({ timeout: 15000 })
console.log('history text:', await page.getByTestId('ai-call-history').innerText())
await page.getByTestId('ai-call-history').locator('button.history-main').first().click()
await page.getByText('Android local call', { exact: false }).first().waitFor({ timeout: 15000 })
await page.getByTestId('ai-call-history').locator('button.history-main').filter({ hasText: 'PC E2E conversation' }).first().click()
await page.getByText('PC E2E conversation', { exact: false }).first().waitFor({ timeout: 15000 })
console.log('PC pulled Android upload and PC record')
await page.getByLabel('搜索通话记录').fill('PC E2E')
await page.getByText('PC E2E conversation', { exact: false }).first().waitFor({ timeout: 5000 })
if (await page.getByText('Android local call', { exact: false }).count() > 0) throw new Error('history search did not filter')
console.log('history search filters records')
await browser.close()
