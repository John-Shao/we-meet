import { chromium } from 'playwright'

const token = process.env.WE_MEET_ACCESS_TOKEN
const base = 'http://127.0.0.1:4173'
const api = 'https://meet.we-meet.online'
if (!token) throw new Error('WE_MEET_ACCESS_TOKEN required')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext()
await context.addInitScript((value) => {
  localStorage.setItem('we-meet:access_token', value)
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
}, token)
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error') console.log('page error:', message.text())
})
await context.route(`${base}/api/**`, async route => {
  const request = route.request()
  const response = await fetch(request.url().replace(base, api), {
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
await page.goto(`${base}/assistant`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '开始对话' }).click()
await page.getByText('对话中', { exact: true }).waitFor({ timeout: 30000 })
console.log('assistant connected')
await page.getByLabel('输入 AI 消息').fill('你好，请用一句话介绍你自己。')
await page.getByRole('button', { name: '发送' }).click()
await page.locator('p').filter({ hasText: 'AI' }).first().waitFor({ timeout: 30000 })
console.log('assistant replied')
await page.screenshot({ path: 'assistant.png', fullPage: true })
await browser.close()
