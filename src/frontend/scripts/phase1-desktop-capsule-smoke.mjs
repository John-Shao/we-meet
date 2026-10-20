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
  let listener = null
  window.__setAiCallStatus = (status) => listener?.(status)
  window.weMeetDesktop = {
    isDesktop: true,
    platform: 'win32',
    shell: {
      openMenu: async () => {},
      setTheme: async () => {},
      getWindowState: async () => ({ fullscreen: false }),
      onWindowState: () => () => {},
    },
    aiCall: {
      open: async () => {},
      reportStatus: async () => {},
      onStatus: (next) => {
        listener = next
        return () => { listener = null }
      },
    },
    getStatus: async () => ({
      version: 'test',
      serviceOrigin: 'https://meet.we-meet.online',
      connection: 'online',
      auth: 'signed-in',
      message: '',
    }),
    login: async () => {},
    logout: async () => {},
    retry: async () => {},
    onStatus: () => () => {},
  }
}, token)
const page = await context.newPage()
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
await page.goto(`${base}/ai-call`, { waitUntil: 'networkidle' })
await page.getByTestId('desktop-titlebar').waitFor({ timeout: 15000 })
await page.evaluate(() => window.__setAiCallStatus({
  state: 'active',
  startedAt: Date.now() - 5000,
  sharing: false,
}))
await page.getByText(/AI 通话中 00:0[4-6]/).waitFor({ timeout: 5000 })
console.log('capsule visible')
await page.evaluate(() => window.__setAiCallStatus({ state: 'ended' }))
await page.getByText(/AI 通话中/).waitFor({ state: 'hidden', timeout: 5000 })
console.log('capsule hidden')
await browser.close()
