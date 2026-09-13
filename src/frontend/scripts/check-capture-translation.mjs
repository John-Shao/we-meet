// Chromium's real microphone worklet and WS serialization, with synthetic input/server only.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { chromium } from '@playwright/test'

const source = { viewerId: '11111111-1111-4111-8111-111111111111', captureId: '22222222-2222-4222-8222-222222222222', recordId: '33333333-3333-4333-8333-333333333333', deviceId: 'web', leaseKey: '44444444-4444-4444-8444-444444444444' }
const config = { source_language: 'zh', target_language: 'en', mode: 'push_to_talk', audio: false, save_translations: false, model: 'qwen3.5-livetranslate-flash-realtime', region: 'cn-beijing' }
const runId = '55555555-5555-4555-8555-555555555555'
const errors = []
const stats = { opens: 0, frames: 0, turns: 0 }
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 8192 })
await once(server, 'listening')
server.on('connection', (socket, request) => {
  stats.opens++
  assert.equal(request.url, '/capture-translation')
  let sequence = 0
  let direction = null
  let turnFrames = 0
  const emit = (value) => socket.send(JSON.stringify({ run_id: runId, capture_id: source.captureId, generation: 1, ...value }))
  socket.on('message', (raw, binary) => {
    try {
      if (binary) {
        assert.equal(raw.readUInt32LE(0), ++sequence)
        assert.ok(direction)
        assert.ok(raw.length >= 36 && raw.length <= 3204)
        for (let i = 4; i < raw.length; i += 2) assert.equal(raw.readInt16LE(i), 1337)
        stats.frames++; turnFrames++
        emit({ type: 'ack', sequence })
        return
      }
      const message = JSON.parse(raw.toString())
      if (message.type === 'authenticate') {
        assert.equal(message.ticket, 'isolated-browser-ticket')
        emit({ type: 'ready', configuration: config })
        return
      }
      assert.equal(message.sequence, ++sequence)
      if (message.type === 'begin') { direction = message.direction; turnFrames = 0 }
      else if (message.type === 'end') {
        assert.equal(message.direction, direction)
        const response_id = `turn-${++stats.turns}`
        if (turnFrames) {
          emit({ type: 'target_final', direction, response_id, item_id: response_id, text: 'Synthetic translation' })
          emit({ type: 'response_completed', direction, response_id, usage: {} })
        } else emit({ type: 'turn_empty', direction, sequence })
        direction = null
      } else if (message.type === 'finish') {
        emit({ type: 'finished', status: 'stopped', complete: true })
        return
      } else assert.fail('unexpected control')
      emit({ type: 'ack', sequence })
    } catch (error) { errors.push(error.message); socket.close(1011) }
  })
})
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
try {
  const page = await browser.newPage({ permissions: ['microphone'] })
  page.setDefaultTimeout(10000)
  page.on('requestfailed', request => console.log('Isolated resource unavailable:', new URL(request.url()).pathname))
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && message.text().startsWith('WebSocket connection')) errors.push(message.text()) })
  // Obtain a real loopback HTTP response so Chromium classifies the address space correctly.
  await page.goto(`${process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'}/@vite/client`)
  await page.setContent('<!doctype html><title>Translation test</title><button>Start synthetic recording</button>')
  await page.evaluate(async ({ source, config, runId, port }) => {
    const { CaptureMicrophone } = await import('/src/features/meetings/capture/microphone.ts')
    const { CaptureTranslationSocket } = await import('/src/features/meetings/capture/translationSocket.ts')
    const device = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.deviceOpens = 0
    navigator.mediaDevices.getUserMedia = (...args) => { window.deviceOpens++; return device(...args) }
    window.originalFrames = 0
    window.failed = false
    document.querySelector('button').onclick = async () => {
      window.mic = await CaptureMicrophone.open(async (pcm) => { window.originalFrames += pcm.length }, () => { window.failed = true })
      window.mic.start()
      const deadline = new Date(Date.now() + 30000).toISOString()
      const run = { id: runId, capture_id: source.captureId, generation: 1, source_revision: 2, configuration: config, status: 'starting', deadline, ended_at: null, error_code: '' }
      const ticket = { ticket: 'isolated-browser-ticket', gateway_url: 'wss://gateway.invalid/capture-translation', expires_at: deadline, source: { run_id: runId, capture_id: source.captureId, user_id: source.viewerId, device_id: source.deviceId, generation: 1, source_revision: 2 } }
      window.translation = new CaptureTranslationSocket({ source, run, ticket, authorized: () => !window.failed,
        observe: (listener) => window.mic.observePcm({ pcm: (samples) => listener.pcm(new Int16Array(samples.length).fill(1337)), ended: listener.ended }),
        changed: (state) => { window.live = state },
        socket: () => new WebSocket(`ws://127.0.0.1:${port}/capture-translation`),
      })
      window.translation.connect()
    }
  }, { source, config, runId, port: server.address().port })
  await page.getByRole('button').click()
  await page.waitForFunction(() => window.live?.phase === 'ready' || window.failed || ['incomplete', 'unknown'].includes(window.live?.phase)).catch(async error => { throw new Error(JSON.stringify({ stats, errors, state: await page.evaluate(() => ({ live: window.live, failed: window.failed, originals: window.originalFrames })) }), {cause: error}) })
  assert.equal(await page.evaluate(() => window.live?.phase), 'ready', JSON.stringify({stats, errors, live: await page.evaluate(() => window.live)}))
  for (const direction of ['forward', 'reverse']) {
    const before = stats.frames
    await page.evaluate((direction) => window.translation.begin(direction), direction)
    const deadline = Date.now() + 10000
    while (stats.frames < before + 2 && errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(stats.frames >= before + 2, JSON.stringify({ stats, errors, live: await page.evaluate(() => window.live) }))
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.translation.endTurn())
    await page.waitForFunction(() => window.live?.phase === 'ready' || ['incomplete', 'unknown'].includes(window.live?.phase))
    assert.equal(await page.evaluate(() => window.live.phase), 'ready')
  }
  await page.evaluate(() => window.translation.finish())
  await page.waitForFunction(() => window.live?.phase === 'stopped')
  await page.waitForFunction(() => window.originalFrames >= 80000 || window.failed, null, { timeout: 10000 })
  const result = await page.evaluate(async () => {
    await window.mic.stop()
    return { failed: window.failed, deviceOpens: window.deviceOpens, originalFrames: window.originalFrames, finals: window.live.finals.length, storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]) }
  })
  assert.equal(result.failed, false)
  assert.equal(result.deviceOpens, 1)
  assert.ok(result.originalFrames >= 80000)
  assert.equal(result.finals, 2)
  assert.equal(result.storage.includes('isolated-browser-ticket'), false)
  assert.deepEqual(errors, [])
  assert.equal(stats.opens, 1)
  assert.equal(stats.turns, 2)
  console.log('Capture translation Chromium checks passed: one microphone, exact WS sequencing, copied PCM, both speech directions, tail commit and continuing original recording.')
} finally {
  await browser.close()
  for (const client of server.clients) client.terminate()
  await new Promise((resolve) => server.close(resolve))
}
