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
await page.getByTestId('ai-call-history').locator('button.history-main').first().click()
await page.getByText('Android E2E conversation', { exact: false }).first().waitFor({ timeout: 10000 })
console.log('PC pulled Android conversation')
await page.getByTestId('ai-call-history').getByRole('button', { name: '删除通话记录' }).first().click()
await page.getByText('Android E2E conversation', { exact: false }).first().waitFor({ state: 'hidden', timeout: 10000 })
console.log('PC deleted local row')

const server = await fetch(`${apiBase}/api/v1.0/ai-call/conversations/`, {
  headers: { Authorization: `Bearer ${token}` },
})
let data = await server.json()
for (let attempt = 0; attempt < 20 && data.conversations.length !== 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 250))
  const retry = await fetch(`${apiBase}/api/v1.0/ai-call/conversations/`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  data = await retry.json()
}
if (data.conversations.length !== 0) throw new Error(`remote still has ${data.conversations.length} conversations`)
console.log('remote deletion synced')
await browser.close()
