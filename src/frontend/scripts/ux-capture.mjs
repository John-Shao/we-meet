import { chromium } from 'playwright'
import fs from 'node:fs'

const token = process.env.WE_MEET_ACCESS_TOKEN
if (!token) throw new Error('WE_MEET_ACCESS_TOKEN required')
const base = 'http://127.0.0.1:4173'
const api = 'https://meet.we-meet.online'
fs.mkdirSync('ux', { recursive: true })

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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript((value) => {
  localStorage.clear()
  localStorage.setItem('we-meet:access_token', value)
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
}, token)
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
const page = await context.newPage()
await page.goto(`${base}/ai-call`, { waitUntil: 'networkidle' })
await page.screenshot({ path: 'ux/01-idle.png', fullPage: true })

await page.getByRole('button', { name: '开始通话' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
await page.waitForTimeout(1000)
await page.screenshot({ path: 'ux/02-audio-active.png', fullPage: true })
await page.getByRole('button', { name: '选择设备' }).click()
await page.locator('.device-menu').waitFor({ timeout: 5000 })
await page.screenshot({ path: 'ux/08-device-menu.png', fullPage: true })
await page.getByRole('button', { name: '选择设备' }).click()

await page.getByRole('button', { name: '开启摄像头' }).click()
await page.getByRole('button', { name: '关闭摄像头' }).waitFor({ timeout: 15000 })
await page.waitForTimeout(800)
await page.screenshot({ path: 'ux/03-camera.png', fullPage: true })
await page.getByRole('button', { name: '关闭摄像头' }).click()

await page.getByRole('button', { name: '共享屏幕' }).click()
await page.getByText('共享中', { exact: false }).waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '读取当前屏幕' }).click()
await page.getByTestId('read-screen-result').waitFor({ timeout: 30000 })
await page.waitForTimeout(800)
await page.screenshot({ path: 'ux/04-sharing-read.png', fullPage: true })

await page.getByRole('button', { name: '停止共享' }).click()
await page.getByRole('button', { name: '挂断' }).click()
await page.getByText('已结束', { exact: true }).waitFor({ timeout: 10000 })
await page.getByRole('tab', { name: '通话记录' }).click()
await page.getByTestId('ai-call-history').locator('button.history-main').first().click()
await page.screenshot({ path: 'ux/05-history.png', fullPage: true })

const floatContext = await browser.newContext({ viewport: { width: 420, height: 700 } })
await floatContext.addInitScript((value) => {
  localStorage.clear()
  localStorage.setItem('we-meet:access_token', value)
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
}, token)
const float = await floatContext.newPage()
await float.route(`${base}/api/**`, async route => {
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
await float.goto(`${base}/ai-call-float`, { waitUntil: 'networkidle' })
await float.screenshot({ path: 'ux/06-float-idle.png', fullPage: true })
await float.getByRole('button', { name: '开始通话' }).click()
await float.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
await float.screenshot({ path: 'ux/07-float-active.png', fullPage: true })
await float.getByRole('button', { name: '挂断' }).click()
console.log('captured')
await browser.close()
