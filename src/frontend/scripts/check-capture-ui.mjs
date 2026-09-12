// Native Chromium UI check with synthetic microphone and an in-memory HTTP test double.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
let remote
let manifest
const chunks = new Map()
const intents = new Map()
const commands = []
try {
  const context = await browser.newContext({ permissions: ['microphone'], locale: 'zh-CN' })
  await context.route('**/capture-ui-harness', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Capture UI test</title><div id="root"></div></html>' }))
  await context.route('**/api/v1.0/capture-sessions/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.split('/capture-sessions/')[1]
    const reply = (body, status = 200) => route.fulfill({ status, json: body })
    if (!path) {
      const body = request.postDataJSON()
      remote ??= { id: 'test-capture', record_id: 'test-record', device_id: body.device_id,
        status: 'preparing', revision: 1, started_at: new Date().toISOString(), ended_at: null,
        media_status: 'not_connected', captured_duration_ms: null, last_acked_sequence: 0,
        missing_ranges: null, coverage_status: 'unverified' }
      return reply({ capture: remote, result: remote, operation_id: 'create', replayed: false })
    }
    if (path.endsWith('/commands/')) {
      const key = request.headers()['idempotency-key']
      if (!intents.has(key)) {
        const body = request.postDataJSON()
        assert.equal(body.expected_revision, remote.revision)
        commands.push(body.command)
        const state = { start: 'recording', resume: 'recording', interrupt: 'interrupted', pause: 'paused', stop: 'stopping', finalize: 'stopped' }[body.command]
        remote = { ...remote, status: state, revision: remote.revision + 1 }
        intents.set(key, { ...remote })
      }
      return reply({ capture: remote, result: intents.get(key), operation_id: key, replayed: false })
    }
    if (path.endsWith('/audio/upload/')) {
      const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData()
      const audio = Buffer.from(await form.get('audio').arrayBuffer())
      assert.equal(createHash('sha256').update(audio).digest('hex'), form.get('checksum'))
      assert.equal(audio.readUInt32LE(24), 16000)
      const sequence = Number(form.get('sequence'))
      const receipt = { id: `chunk-${sequence}`, sequence, start_ms: Number(form.get('start_ms')),
        duration_ms: audio.readUInt32LE(40) / 32, checksum: form.get('checksum'), byte_size: audio.length, stored: true }
      if (chunks.has(sequence)) assert.deepEqual(receipt, chunks.get(sequence))
      chunks.set(sequence, receipt)
      return reply(receipt)
    }
    if (path.endsWith('/audio/seal/')) {
      manifest ??= request.postDataJSON()
      assert.equal(manifest.final_sequence, chunks.size)
      remote = { ...remote, media_status: manifest.client_interrupted ? 'incomplete' : 'saved' }
      return reply({ ...manifest, outcome: remote.media_status, missing_sequences: [], gaps: [], coverage_status: 'unverified' })
    }
    if (path.endsWith('/audio/')) return reply({ results: [...chunks.values()], next_after_sequence: null })
    return reply(remote)
  })
  const page = await context.newPage()
  await page.goto(`${origin}/capture-ui-harness`)
  const mount = async () => page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { Recorder } = await import('/src/features/meetings/routes/AudioRecording.tsx')
    createRoot(document.getElementById('root')).render(React.createElement(Recorder, { viewerId: 'ui-test-owner', available: true }))
  })
  await mount()
  await page.getByLabel('录音名称').fill('项目评审录音')
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  await page.waitForFunction(() => document.body.textContent.includes('本机已记录 0:05'), null, { timeout: 15000 })
  await page.getByRole('button', { name: '暂停录音', exact: true }).click()
  await page.getByRole('button', { name: '继续录音', exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/capture-paused.png', fullPage: true })
  // A paused recording has no unsaved microphone tail. Reload keeps its exact lease and sequence.
  page.on('dialog', (dialog) => dialog.accept())
  await page.reload()
  await mount()
  await page.getByRole('button', { name: '结束并保存', exact: true }).click()
  await page.getByText('已保存收到的音频', { exact: true }).waitFor()
  assert.deepEqual(commands, ['start', 'pause', 'stop', 'finalize'])
  assert.equal(manifest.client_interrupted, false)
  assert.ok(chunks.size >= 1)
  await page.screenshot({ path: 'test-results/capture-saved.png', fullPage: true })
  console.log('Capture UI passed: start, synthetic audio upload, pause, reload, receipt recovery, seal and finalize.')
} finally { await browser.close() }
