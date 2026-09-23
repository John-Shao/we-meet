// Real React controls, AudioWorklet and WS; isolated synthetic device/backend/provider only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { chromium } from '@playwright/test'

const source = { viewerId: '11111111-1111-4111-8111-111111111111', captureId: '22222222-2222-4222-8222-222222222222', recordId: '33333333-3333-4333-8333-333333333333', deviceId: 'web', leaseKey: '44444444-4444-4444-8444-444444444444' }
let run = null
let frames = 0
let turns = 0
let connections = 0
const errors = []
const snapshot = () => ({ source: { capture_id: source.captureId, record_id: source.recordId, revision: 2, status: 'recording' }, available: true, can_start: !run || run.status === 'stopped', can_stop: !!run && run.status === 'starting', can_save_translations: true, current: run })
const viteOrigin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const fixture = createServer(async (request, response) => {
  if (request.url !== '/') {
    try {
      const upstream = await fetch(viteOrigin + request.url)
      response.statusCode = upstream.status
      response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { response.statusCode = 502; response.end() }
    return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end('<!doctype html><html lang="en" data-lk-theme="visio-light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recording translation UI</title></head><body><button id="mic">Start synthetic recording</button><div id="root"></div></body></html>')
})
const server = new WebSocketServer({ server: fixture, path: '/capture-translation' })
fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
server.on('connection', socket => {
  connections++
  let sequence = 0
  let direction
  const emit = value => socket.send(JSON.stringify({ capture_id: source.captureId, run_id: run.id, generation: 1, ...value }))
  socket.on('message', (raw, binary) => {
    try {
      if (binary) {
        assert.equal(raw.readUInt32LE(0), ++sequence); assert.ok(direction); frames++
      } else {
        const message = JSON.parse(raw.toString())
        if (message.type === 'authenticate') {
          assert.equal(message.ticket, 'isolated-ui-ticket')
          emit({ type: 'ready', configuration: run.configuration }); return
        }
        assert.equal(message.sequence, ++sequence)
        if (message.type === 'begin') direction = message.direction
        else if (message.type === 'end') {
          assert.equal(message.direction, direction)
          const id = `turn-${++turns}`
          emit({ type: 'target_final', direction, response_id: id, item_id: id, text: direction === 'forward' ? 'We will finish the design review tomorrow.' : '明天完成设计评审。' })
          emit({ type: 'response_completed', direction, response_id: id })
          direction = undefined
        } else if (message.type === 'finish') {
          run = { ...run, status: 'stopped', ended_at: new Date().toISOString() }
          emit({ type: 'finished', status: 'stopped', complete: true }); return
        } else assert.fail('unexpected control')
      }
      emit({ type: 'ack', sequence })
    } catch (error) { errors.push(error.message); socket.close(1011) }
  })
})
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
try {
  const page = await browser.newPage({ permissions: ['microphone'], viewport: { width: 980, height: 850 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => { errors.push(error.message); console.log('Page error:', error.stack) })
  await page.route('**/api/v1.0/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/ticket/')) return route.fulfill({ json: { ticket: 'isolated-ui-ticket', gateway_url: 'wss://gateway.invalid/capture-translation', expires_at: new Date(Date.now() + 30000).toISOString(), source: { run_id: run.id, capture_id: source.captureId, user_id: source.viewerId, device_id: source.deviceId, generation: 1, source_revision: 2 } } })
    if (path.endsWith('/translation/')) {
      if (request.method() !== 'POST') return route.fulfill({ json: snapshot() })
      const { key, ...payload } = request.postDataJSON()
      assert.equal(request.headers()['x-capture-lease'], source.leaseKey)
      assert.equal(payload.operation, 'start')
      run = { id: '55555555-5555-4555-8555-555555555555', capture_id: source.captureId, generation: 1, source_revision: 2, status: 'starting', deadline: new Date(Date.now() + 30000).toISOString(), ended_at: null, error_code: '', configuration: { ...payload.configuration, model: 'qwen3.8-livetranslate-flash-realtime', region: 'cn-beijing' } }
      return route.fulfill({ json: { command: { key, capture_id: source.captureId, payload, result: run }, current: snapshot(), replayed: false } })
    }
    return route.fulfill({ json: path.endsWith('/directory/me/') ? { id: source.viewerId } : {} })
  })
  await page.goto(`http://127.0.0.1:${fixture.address().port}/`)
  await page.evaluate(async ({ source, port, origin }) => {
    const runtime = (await import(`${origin}/@react-refresh`)).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined; window.$RefreshSig$ = () => type => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import(`${origin}/src/styles/index.css`)
    localStorage.setItem('i18nextLng', 'en')
    await import(`${origin}/src/i18n/init.ts`)
    const React = (await import(`${origin}/node_modules/.vite/deps/react.js`)).default
    const { createRoot } = (await import(`${origin}/node_modules/.vite/deps/react-dom_client.js`)).default
    const { CaptureMicrophone } = await import(`${origin}/src/features/meetings/capture/microphone.ts`)
    const { CaptureTranslationPanel } = await import(`${origin}/src/features/meetings/components/CaptureTranslationPanel.tsx`)
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket { constructor(url, protocols) { super(url === 'wss://gateway.invalid/capture-translation' ? `ws://127.0.0.1:${port}/capture-translation` : url, protocols) } }
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.microphones = 0; window.originalFrames = 0
    navigator.mediaDevices.getUserMedia = (...args) => { window.microphones++; return getUserMedia(...args) }
    document.getElementById('mic').onclick = async () => {
      window.mic = await CaptureMicrophone.open(async pcm => { window.originalFrames += pcm.length }, () => { window.captureFailed = true })
      window.mic.start()
      const controller = { state: { mode: 'recording', busy: false, local: { create: { device_id: source.deviceId, lease_key: source.leaseKey, retention_mode: 'media' }, remote: { id: source.captureId, revision: 2, status: 'recording' } } }, observePcm: (_id, listener) => window.mic.observePcm(listener) }
      createRoot(document.getElementById('root')).render(React.createElement(React.Suspense, { fallback: 'Loading' }, React.createElement(CaptureTranslationPanel, { source, revision: 2, controller })))
    }
  }, { source, port: fixture.address().port, origin: `http://127.0.0.1:${fixture.address().port}` })
  await page.getByRole('button', { name: 'Start synthetic recording' }).click()
  await page.getByLabel('Mode', { exact: true }).selectOption('push_to_talk')
  await page.getByRole('button', { name: 'Start translation', exact: true }).click()
  for (const language of ['Chinese', 'English']) {
    const before = frames
    await page.getByRole('button', { name: `Start speaking ${language}`, exact: true }).click()
    const deadline = Date.now() + 10000
    while (frames < before + 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(frames >= before + 3)
    await page.getByRole('button', { name: `Finish ${language} speech and translate`, exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Translation ready' }).waitFor()
  }
  await page.getByText('We will finish the design review tomorrow.', { exact: true }).waitFor()
  await page.getByText('明天完成设计评审。', { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  if (process.env.CAPTURE_TRANSLATION_UI_SCREENSHOT) await page.screenshot({ path: process.env.CAPTURE_TRANSLATION_UI_SCREENSHOT, fullPage: true })
  await page.getByRole('button', { name: 'End translation', exact: true }).click()
  await page.getByText('Translation ended', { exact: true }).waitFor()
  await page.waitForFunction(() => window.originalFrames >= 80000)
  assert.equal(await page.evaluate(() => window.microphones), 1)
  assert.equal(await page.evaluate(() => !!window.captureFailed), false)
  assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('isolated-ui-ticket')), false)
  await page.evaluate(async () => { await window.mic.stop(); window.mic.close() })
  assert.equal(connections, 1); assert.equal(turns, 2); assert.deepEqual(errors, [])
  console.log('Capture translation UI passed: explicit controls, two directions, responsive layout, one microphone, continuing recording.')
} finally {
  await browser.close()
  for (const client of server.clients) client.terminate()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => fixture.close(resolve))
}
