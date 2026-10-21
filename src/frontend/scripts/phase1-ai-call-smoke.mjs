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
const media = async () => JSON.parse(await page.getByTestId('media-state').innerText())
const waitMedia = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const state = await media()
    if (predicate(state)) return state
    await page.waitForTimeout(200)
  }
  throw new Error(`media state timed out: ${label}: ${JSON.stringify(await media())}`)
}
await page.getByRole('button', { name: '开始通话' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 30000 })
const audioState = await waitMedia(state =>
  state.audio?.[0] === 'live' && state.connection === 'connected' &&
  state.channel === 'open' && state.remoteAudio === true,
  'audio call')
console.log('connected', JSON.stringify(audioState))
await page.getByRole('button', { name: '静音' }).click()
await waitMedia(state => state.micMuted === true && state.audioEnabled === false, 'mic muted')
await page.getByRole('button', { name: '取消静音' }).click()
await waitMedia(state => state.micMuted === false && state.audioEnabled === true, 'mic unmuted')
console.log('mic muted and restored')
await page.getByLabel('输入消息').fill('你好')
await page.getByRole('button', { name: '发送' }).click()
await page.locator('p').filter({ hasText: '你好' }).waitFor({ timeout: 5000 })
console.log('text sent')
await page.getByRole('button', { name: '开启摄像头' }).click()
await page.getByRole('button', { name: '关闭摄像头' }).waitFor({ timeout: 15000 })
const cameraState = await waitMedia(state =>
  state.camera?.[0] === 'live' && state.sender === 'video' && state.senderState === 'live',
  'camera on')
if (!(await page.getByTestId('camera-preview').isVisible())) throw new Error('camera preview hidden')
console.log('camera on', JSON.stringify(cameraState))
await page.getByRole('button', { name: '关闭摄像头' }).click()
await page.getByRole('button', { name: '开启摄像头' }).waitFor({ timeout: 10000 })
const cameraOffState = await waitMedia(state => !state.sender && state.camera.length === 0, 'camera off')
if (await page.getByTestId('camera-preview').isVisible()) throw new Error('camera preview still visible')
console.log('camera off', JSON.stringify(cameraOffState))
await page.getByRole('button', { name: '共享屏幕' }).click()
await page.getByText('共享中', { exact: false }).waitFor({ timeout: 15000 })
const shareState = await waitMedia(state =>
  state.screen?.[0] === 'live' && state.sender === 'video' &&
  ['monitor', 'window'].includes(state.screenSurface),
  'screen sharing')
if (!(await page.getByTestId('screen-preview').isVisible())) throw new Error('screen preview hidden')
console.log('sharing', JSON.stringify(shareState))
await page.getByRole('button', { name: '读取当前屏幕' }).click()
await page.getByTestId('read-screen-result').waitFor({ timeout: 30000 })
console.log('read screen:', await page.getByTestId('read-screen-result').innerText())
await page.getByRole('button', { name: '停止共享' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 10000 })
const stopShareState = await waitMedia(state => !state.sender && state.screen.length === 0, 'share stopped')
if (await page.getByTestId('screen-preview').isVisible()) throw new Error('screen preview still visible')
console.log('share stopped', JSON.stringify(stopShareState))
await page.getByRole('button', { name: '挂断' }).click()
await page.getByText('已结束', { exact: true }).waitFor({ timeout: 10000 })
await page.getByRole('tab', { name: '通话记录' }).click()
await page.getByTestId('ai-call-history').getByRole('button', { name: '删除通话记录' }).first().waitFor({ timeout: 5000 })
console.log('history saved')
await page.reload({ waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '通话记录' }).click()
await page.getByTestId('ai-call-history').getByRole('button', { name: '删除通话记录' }).first().waitFor({ timeout: 10000 })
console.log('history persisted')
console.log('ended')
await browser.close()
