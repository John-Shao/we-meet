import { chromium } from 'playwright'
const token = process.env.WE_MEET_ACCESS_TOKEN
const base = 'http://127.0.0.1:4173'
const api = 'https://meet.we-meet.online'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const context = await browser.newContext()
await context.addInitScript(() => {
  const state = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'connectionState')
  Object.defineProperty(RTCPeerConnection.prototype, 'connectionState', {
    configurable: true,
    get() { return this.__forcedConnectionState ?? state.get.call(this) },
  })
  const add = RTCPeerConnection.prototype.addEventListener
  RTCPeerConnection.prototype.addEventListener = function (type, listener, options) {
    window.__lastPc = this
    return add.call(this, type, listener, options)
  }
})
await context.addInitScript(value => {
  localStorage.setItem('we-meet:access_token', value)
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
}, token)
await context.route(`${base}/api/**`, async route => {
  const request = route.request()
  const response = await fetch(request.url().replace(base, api), { method: request.method(), headers: request.headers(), body: request.postDataBuffer() ?? undefined })
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
})
const page = await context.newPage()
await page.goto(`${base}/ai-call`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '开始通话' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
const firstPc = await page.evaluate(() => window.__lastPc)
await page.evaluate(() => { const pc = window.__lastPc; window.__firstPc = pc; pc.__forcedConnectionState = 'failed'; pc.dispatchEvent(new Event('connectionstatechange')) })
await page.getByText('正在重连…', { exact: true }).waitFor({ timeout: 5000 })
console.log('offline state detected')
await page.locator('.status-pill').filter({ hasText: '正在连接' }).waitFor({ timeout: 10000 })
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
const result = await page.evaluate(() => ({ same: window.__lastPc === window.__firstPc, reconnected: !!window.__lastPc }))
const media = JSON.parse(await page.getByTestId('media-state').innerText())
if (media.connection !== 'connected') throw new Error(`not reconnected: ${JSON.stringify(media)}`)
console.log(JSON.stringify({ firstPc: !!firstPc, result, media }))
await page.getByRole('button', { name: '挂断' }).click()
await browser.close()

