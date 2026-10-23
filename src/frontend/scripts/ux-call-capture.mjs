import { chromium } from 'playwright'
import fs from 'node:fs'

const base = 'http://127.0.0.1:5173'
const outDir = process.env.UX_OUT ?? 'ux-call-after'
fs.mkdirSync(outDir, { recursive: true })

const installMocks = () => {
  class FakeChannel extends EventTarget {
    constructor(label) {
      super()
      this.label = label
      this.readyState = 'connecting'
      this.onopen = null
      this.responseId = 0
    }
    emit(payload) {
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(payload) })
      )
    }
    send(raw) {
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      if (payload.type !== 'response.create') return
      if (!this.didReadScreen) {
        this.didReadScreen = true
        this.emit({
          type: 'response.function_call_arguments.done',
          call_id: 'call-read-1',
          name: 'read_screen',
          arguments: JSON.stringify({ question: '屏幕上显示的文字是什么？' }),
        })
        return
      }
      const id = `resp-${++this.responseId}`
      const parts = ['好的，', '我正在查看你共享的画面。', '这是测试读屏结果。']
      this.emit({ type: 'response.created', response: { id } })
      parts.forEach((delta, index) => {
        setTimeout(
          () =>
            this.emit({
              type: 'response.audio_transcript.delta',
              response_id: id,
              delta,
            }),
          100 + index * 120
        )
      })
      setTimeout(
        () => this.emit({ type: 'response.done', response: { id } }),
        100 + parts.length * 120
      )
    }
    close() {
      this.readyState = 'closed'
    }
  }

  class FakePeerConnection extends EventTarget {
    constructor() {
      super()
      this._connectionState = 'new'
      this._iceGatheringState = 'complete'
      this.localDescription = null
      this.channels = []
      this.ontrack = null
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
      setTimeout(() => {
        this._connectionState = 'connected'
        this.dispatchEvent(new Event('connectionstatechange'))
        for (const channel of this.channels) {
          channel.readyState = 'open'
          const event = new Event('open')
          channel.dispatchEvent(event)
          channel.onopen?.(event)
          channel.emit({ type: 'session.created', session: {} })
          channel.emit({ type: 'session.updated', session: {} })
        }
      }, 80)
    }
    async getStats() {
      return new Map()
    }
    close() {
      this._connectionState = 'closed'
    }
  }
  window.RTCPeerConnection = FakePeerConnection

  const makeCanvasStream = (label, color) => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 540
    const context = canvas.getContext('2d')
    const paint = () => {
      if (!context) return
      context.fillStyle = color
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#ffffff'
      context.font = '42px sans-serif'
      context.fillText(label, 48, 96)
      context.font = '24px sans-serif'
      context.fillText('UX review capture', 48, 144)
    }
    paint()
    setInterval(paint, 1000)
    return canvas.captureStream(15)
  }

  const audioStream = () => {
    const context = new AudioContext()
    const destination = context.createMediaStreamDestination()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    return destination.stream
  }

  const mediaDevices = {
    getUserMedia: async (constraints) => {
      if (constraints?.audio) return audioStream()
      return makeCanvasStream('Camera', '#1d4ed8')
    },
    getDisplayMedia: async () => makeCanvasStream('Shared screen', '#15803d'),
    enumerateDevices: async () => [
      {
        kind: 'audioinput',
        deviceId: 'mic-1',
        label: '麦克风阵列',
        groupId: 'a',
      },
      {
        kind: 'audioinput',
        deviceId: 'mic-2',
        label: '通讯麦克风',
        groupId: 'a',
      },
      {
        kind: 'videoinput',
        deviceId: 'cam-1',
        label: 'TranScreen Camera',
        groupId: 'v',
      },
      {
        kind: 'videoinput',
        deviceId: 'cam-2',
        label: 'USB 视频设备',
        groupId: 'v',
      },
    ],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices,
  })
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

const history = {
  id: 'history-1',
  startedAt: Date.now() - 15 * 60 * 1000,
  seconds: 198,
  title: '屏幕上显示的文字是什么？',
  summary: '讨论屏幕共享和读屏能力。',
  todos: [
    { text: '确认共享范围仅包含当前窗口', done: true },
    { text: '补充隐私说明' },
  ],
  rows: [
    { id: 'h-u1', role: 'user', text: '屏幕上显示的文字是什么？' },
    {
      id: 'h-a1',
      role: 'assistant',
      text: '屏幕上显示的是 **UX review capture**。',
    },
  ],
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
await context.addInitScript(() => {
  localStorage.setItem('we-meet:access_token', 'ux-token')
  localStorage.setItem('we-meet:auth_session', crypto.randomUUID())
  localStorage.setItem('we-meet:rail-collapsed', '0')
  localStorage.setItem('i18nextLng', 'zh')
  localStorage.setItem('we-meet:ai-call-history', JSON.stringify([]))
})
await context.addInitScript(installMocks)
await context.route('http://localhost:8071/api/**', async (route) => {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.endsWith('/config/')) return json(route, config)
  if (path.endsWith('/users/me')) return json(route, user)
  if (path.includes('/approval/')) return json(route, { results: [] })
  if (path.includes('/rooms/ai-agent-config/'))
    return json(route, { profiles: [{ code: 'qwen', display_name: 'Qwen' }] })
  if (path.includes('/ai-call/session/'))
    return json(route, {
      sdp: 'v=0\r\n',
      voice: 'Tina',
      instructions: '你是一个友好、简洁的 AI 助手。',
      session_lease: { id: 'lease-ux' },
    })
  if (path.includes('/ai-call/photo/'))
    return json(route, {
      answer: '**UX review capture** 是当前共享画面中的标题文字。',
    })
  if (path.includes('/ai-call/conversations/'))
    return json(route, { conversations: [history] })
  return json(route, {})
})
const page = await context.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') console.log('page error:', message.text())
})
page.on('pageerror', (error) => console.log('page exception:', error.message))
await page.goto(`${base}${process.env.UX_ROUTE ?? '/ai-call'}`, {
  waitUntil: 'networkidle',
})
await page.screenshot({ path: `${outDir}/01-idle.png`, fullPage: true })

await page.getByRole('button', { name: '开始通话' }).click()
await page.getByText('通话中', { exact: true }).waitFor({ timeout: 15000 })
await page.waitForTimeout(500)
await page.screenshot({ path: `${outDir}/02-active.png`, fullPage: true })

await page.getByRole('button', { name: '选择设备' }).click()
await page.locator('.device-menu').waitFor({ timeout: 5000 })
await page.screenshot({ path: `${outDir}/03-device.png`, fullPage: true })
await page.mouse.click(500, 400)
await page.getByRole('button', { name: '开启摄像头' }).click()
await page
  .getByRole('button', { name: '关闭摄像头' })
  .waitFor({ timeout: 10000 })
await page.waitForTimeout(300)
await page.screenshot({ path: `${outDir}/04-camera.png`, fullPage: true })
await page.getByRole('button', { name: '关闭摄像头' }).click()

await page.getByRole('button', { name: '共享屏幕' }).click()
await page
  .getByRole('button', { name: '读取当前屏幕' })
  .waitFor({ timeout: 10000 })
await page.screenshot({ path: `${outDir}/05-sharing.png`, fullPage: true })
await page.getByRole('button', { name: '读取当前屏幕' }).click()
await page.getByTestId('read-screen-result').waitFor({ timeout: 15000 })
await page.waitForTimeout(600)
await page.screenshot({ path: `${outDir}/06-read.png`, fullPage: true })

await page.getByRole('button', { name: '停止共享' }).click()
await page.getByRole('button', { name: '挂断' }).click()
await page.getByText('已结束', { exact: true }).waitFor({ timeout: 10000 })
await page.screenshot({ path: `${outDir}/07-ended.png`, fullPage: true })
await page.getByRole('tab', { name: '通话记录' }).click()
await page.locator('.history-card').first().waitFor({ timeout: 5000 })
await page.screenshot({ path: `${outDir}/08-history.png`, fullPage: true })

await browser.close()
console.log(`captured to ${outDir}`)
