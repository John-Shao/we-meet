import { chromium } from 'playwright'
import fs from 'node:fs'

const base = 'http://127.0.0.1:5173'
const outDir = process.env.UX_OUT ?? 'ux-assistant-after'
fs.mkdirSync(outDir, { recursive: true })

const fakeRtc = () => {
  class FakeChannel extends EventTarget {
    constructor(label) {
      super()
      this.label = label
      this.readyState = 'connecting'
      this.onopen = null
      this.onmessage = null
      this.sent = []
      this.responseId = 0
    }
    emit(payload) {
      const event = new MessageEvent('message', {
        data: JSON.stringify(payload),
      })
      this.dispatchEvent(event)
      this.onmessage?.(event)
    }
    send(raw) {
      this.sent.push(raw)
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      if (payload.type !== 'response.create') return
      const id = `resp-${++this.responseId}`
      const parts = [
        '当然可以。',
        '这是主窗口 AI 助手的一条流式回答。',
        '它支持 Markdown，例如 **重点** 与 `代码`。',
      ]
      this.emit({ type: 'response.created', response: { id } })
      parts.forEach((delta, index) => {
        setTimeout(
          () =>
            this.emit({
              type: 'response.audio_transcript.delta',
              response_id: id,
              delta,
            }),
          120 + index * 140
        )
      })
      setTimeout(
        () => this.emit({ type: 'response.done', response: { id } }),
        120 + parts.length * 140
      )
    }
    close() {
      this.readyState = 'closed'
    }
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.destination = null
    }
    async resume() {}
    async close() {}
    createMediaStreamDestination() {
      this.destination = { stream: new MediaStream() }
      return this.destination
    }
    createOscillator() {
      return { connect: () => ({ connect: () => {} }), start: () => {} }
    }
    createGain() {
      return { gain: { value: 0 }, connect: (node) => node }
    }
  }
  window.AudioContext = FakeAudioContext
  class FakePeerConnection extends EventTarget {
    constructor() {
      super()
      this._connectionState = 'new'
      this._iceGatheringState = 'complete'
      this.localDescription = null
      this.channels = []
      Object.defineProperty(this, 'connectionState', {
        configurable: true,
        get: () => this._connectionState,
        set: (value) => {
          this._connectionState = value
        },
      })
      Object.defineProperty(this, 'iceGatheringState', {
        configurable: true,
        get: () => this._iceGatheringState,
        set: (value) => {
          this._iceGatheringState = value
        },
      })
    }
    createDataChannel(label) {
      console.log('fake: createDataChannel', label)
      const channel = new FakeChannel(label)
      this.channels.push(channel)
      return channel
    }
    getConfiguration() {
      return { iceServers: [] }
    }
    restartIce() {}
    addTrack() {
      return { replaceTrack: async () => {} }
    }
    addTransceiver() {
      return { sender: { replaceTrack: async () => {} } }
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\n' }
    }
    async setLocalDescription(description) {
      this.localDescription = description
    }
    async setRemoteDescription() {
      console.log('fake: setRemoteDescription')
      setTimeout(() => {
        console.log('fake: opening channels')
        this.connectionState = 'connected'
        this.dispatchEvent(new Event('connectionstatechange'))
        for (const channel of this.channels) {
          channel.readyState = 'open'
          const event = new Event('open')
          channel.dispatchEvent(event)
          channel.onopen?.(event)
          channel.emit({ type: 'session.created', session: {} })
        }
        const remote = new FakeChannel('txt')
        remote.readyState = 'open'
        this.channels.push(remote)
        const datachannel = new Event('datachannel')
        datachannel.channel = remote
        this.dispatchEvent(datachannel)
        remote.emit({ type: 'session.updated', session: {} })
      }, 80)
    }
    async getStats() {
      return new Map()
    }
    close() {
      this.connectionState = 'closed'
    }
  }
  window.RTCPeerConnection = FakePeerConnection
}

const config = {
  is_silent_login_enabled: false,
  livekit: {
    url: '',
    force_wss_protocol: false,
    enable_firefox_proxy_workaround: false,
    default_sources: [],
  },
  feedback: { url: '' },
  background_image: {
    upload_is_enabled: false,
    max_size: 0,
    max_count_by_user: 0,
    allowed_extensions: [],
    allowed_mimetypes: [],
  },
  subtitle: { enabled: false },
  telephony: { enabled: false },
  meeting_records: { enabled: false, summary_requests_enabled: false },
  calendar: { enabled: false, sharing_enabled: false, export_enabled: false },
  work: { enabled: false },
  search_ai: { enabled: false },
  docs: { url: null },
}

const user = {
  id: 'ux-user',
  email: 'ux@example.com',
  full_name: 'UX 评审',
  language: 'zh',
  is_staff: false,
}

const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const context = await browser.newContext({
  viewport: {
    width: Number(process.env.UX_WIDTH ?? 1440),
    height: Number(process.env.UX_HEIGHT ?? 900),
  },
})
await context.addInitScript(fakeRtc)
await context.addInitScript(() => {
  localStorage.setItem('we-meet:access_token', 'ux-token')
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
  localStorage.setItem('we-meet:rail-collapsed', '0')
  localStorage.setItem('i18nextLng', 'zh')
})
await context.addInitScript((theme) => {
  if (theme) localStorage.setItem('app_theme', JSON.stringify({ mode: theme }))
}, process.env.UX_THEME)
await context.route('http://localhost:8071/api/**', async (route) => {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.endsWith('/config/')) return json(route, config)
  if (path.endsWith('/users/me')) return json(route, user)
  if (path.includes('/approval/')) return json(route, [])
  if (path.includes('/rooms/ai-agent-config/'))
    return json(route, { profiles: [{ code: 'qwen', display_name: 'Qwen' }] })
  if (path.includes('/ai-call/session/'))
    return json(route, {
      sdp: 'v=0\r\n',
      voice: 'Tina',
      instructions: '你是一个友好、简洁的 AI 助手。',
      session_lease: { id: 'lease-ux' },
    })
  if (path.includes('/ai-call/conversations/'))
    return json(route, { conversations: [] })
  return json(route, {})
})
const page = await context.newPage()
page.on('console', (message) => {
  console.log(`page ${message.type()}:`, message.text())
})
page.on('pageerror', (error) => console.log('page exception:', error.message))
page.on('requestfailed', (request) =>
  console.log('request failed:', request.url(), request.failure()?.errorText)
)
await page.goto(`${base}/assistant`, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${outDir}/before-idle.png`, fullPage: true })

const start = page.getByRole('button', { name: '开始对话' })
if (await start.count()) {
  await start.click()
  try {
    await page
      .locator('header')
      .getByText('已连接', { exact: true })
      .waitFor({ timeout: 15000 })
  } catch (error) {
    console.log(
      'body:',
      (await page.locator('body').innerText()).slice(0, 1200)
    )
    await page.screenshot({
      path: `${outDir}/before-failed.png`,
      fullPage: true,
    })
    throw error
  }
  await page.screenshot({ path: `${outDir}/before-active.png`, fullPage: true })
  await page.getByLabel('输入消息').fill('你好，请介绍一下你能做什么。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page
    .getByText('这是主窗口 AI 助手的一条流式回答。', { exact: false })
    .waitFor({ timeout: 15000 })
  await page.screenshot({ path: `${outDir}/before-reply.png`, fullPage: true })
  await page
    .getByRole('button', { name: '停止生成' })
    .waitFor({ state: 'hidden', timeout: 15000 })
  await page
    .getByText('支持 Markdown', { exact: false })
    .waitFor({ timeout: 15000 })
  await page.screenshot({
    path: `${outDir}/before-reply-done.png`,
    fullPage: true,
  })
}
await browser.close()
console.log(`captured to ${outDir}`)
