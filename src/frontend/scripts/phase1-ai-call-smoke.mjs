import { chromium } from 'playwright'

const token = process.env.WE_MEET_ACCESS_TOKEN
const base = 'http://127.0.0.1:4173'
const api = process.env.WE_MEET_API_BASE || 'https://meet.we-meet.online'
const path = process.env.WE_MEET_PATH || '/ai-call'
if (!token) throw new Error('WE_MEET_ACCESS_TOKEN required')

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
  ],
})
const context = await browser.newContext({
  permissions: ['microphone', 'camera'],
  viewport: path.includes('float') ? { width: 420, height: 700 } : undefined,
})
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
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
})
await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '开始通话' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
console.log('connected')
await page.getByLabel('输入消息').fill('你好')
await page.getByRole('button', { name: '发送' }).click()
await page.locator('p').filter({ hasText: '你好' }).waitFor({ timeout: 5000 })
console.log('text sent')
await page.getByRole('button', { name: '开启摄像头' }).click()
await page.getByRole('button', { name: '关闭摄像头' }).waitFor({ timeout: 15000 })
console.log('camera on')
await page.getByRole('button', { name: '关闭摄像头' }).click()
await page.getByRole('button', { name: '开启摄像头' }).waitFor({ timeout: 10000 })
console.log('camera off')
await page.getByRole('button', { name: '共享屏幕' }).click()
await page.getByText('共享中', { exact: false }).waitFor({ timeout: 15000 })
console.log('sharing')
await page.getByRole('button', { name: '让 AI 读屏' }).click()
await page.getByTestId('read-screen-result').waitFor({ timeout: 30000 })
console.log('read screen:', await page.getByTestId('read-screen-result').innerText())
await page.getByRole('button', { name: '停止共享' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 10000 })
console.log('share stopped')
await page.getByRole('button', { name: '挂断' }).click()
await page.getByText('已结束', { exact: true }).waitFor({ timeout: 10000 })
await page.getByTestId('ai-call-history').getByRole('button', { name: '删除通话记录' }).first().waitFor({ timeout: 5000 })
console.log('history saved')
await page.reload({ waitUntil: 'networkidle' })
await page.getByTestId('ai-call-history').getByRole('button', { name: '删除通话记录' }).first().waitFor({ timeout: 10000 })
console.log('history persisted')
console.log('ended')
await browser.close()
