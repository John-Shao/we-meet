// Native Chromium UI check with synthetic microphone and an in-memory HTTP test double.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
let remote
let manifest
let asrJob
let summaryReady = false
const sourceRef = { segment_id: 'original', segment_revision: 1, start_ms: 1000, end_ms: 2000 }
const chunks = new Map()
const audioBytes = new Map()
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
      audioBytes.set(receipt.id, audio)
      return reply(receipt)
    }
    if (path.endsWith('/audio/seal/')) {
      manifest ??= request.postDataJSON()
      assert.equal(manifest.final_sequence, chunks.size)
      remote = { ...remote, media_status: manifest.client_interrupted ? 'incomplete' : 'saved' }
      return reply({ ...manifest, outcome: remote.media_status, missing_sequences: [], gaps: [], coverage_status: 'unverified' })
    }
    if (path.endsWith('/audio/')) return reply({ results: [...chunks.values()], next_after_sequence: null,
      manifest: manifest ? { ...manifest, outcome: remote.media_status } : null })
    if (path.includes('/audio/chunk-')) return route.fulfill({ contentType: 'audio/wav', body: audioBytes.get(path.split('/audio/')[1].replace(/\/$/, '')) })
    if (path.endsWith('/transcription/')) {
      if (request.method() === 'POST') {
        assert.deepEqual(request.postDataJSON(), { expected_job_id: null, allow_incomplete: false })
        assert.ok(request.headers()['idempotency-key'])
        asrJob ??= { id: 'published-job', generation: 1, status: 'succeeded', input_count: chunks.size, acknowledged_inputs: chunks.size, final_count: 1 }
        return reply({ job: asrJob }, 201)
      }
      return reply({ available: true, summary_available: true, active_job_id: asrJob?.id ?? null, results: asrJob ? [asrJob] : [] })
    }
    return reply(remote)
  })
  await context.route('**/api/v1.0/meeting-records/**', (route) => {
    const url = new URL(route.request().url())
    const reply = (json) => route.fulfill({ json })
    if (url.pathname.endsWith('/original-segments/')) {
      assert.equal(url.searchParams.get('transcription_job_id'), 'published-job')
      return reply({ results: [{ id: 'original', start_ms: 1000, text: '用于界面验证的模拟转写结果。' }], next_cursor: null })
    }
    if (url.pathname.endsWith('/summary-requests/')) {
      assert.equal(route.request().postDataJSON().operation, 'generate')
      summaryReady = true
      return reply({ request_id: 'summary-intent', replayed: false })
    }
    if (url.pathname.endsWith('/summary-job/')) return reply({ revision: 2, generation_ready: true,
      job: summaryReady ? { id: 'summary-job', status: 'succeeded', attempt: 1, stage: 'final' } : null })
    if (url.pathname.endsWith('/summary-versions/')) return reply({ next_cursor: null, results: summaryReady ? [{
      id: 'summary', input_snapshot_id: 'snapshot', created_at: new Date().toISOString(), is_current: true,
      delivery_status: 'complete', asr_status: 'finished', coverage_status: 'unverified', stage: 'final',
      content: { overview: '用于界面验证的模拟纪要。', decisions: [{ text: '模拟会议结论', source_refs: [sourceRef] }], chapters: [], action_items: [], open_questions: [] }
    }] : [] })
    if (url.pathname.includes('/transcript-versions/')) return reply({ id: 'snapshot', revision: 2, segments: [{ ...sourceRef, text: '模拟纪要的原文依据。' }] })
    if (url.pathname.endsWith('/human-summary/')) return reply({ current: null, can_edit: false })
    if (url.pathname.endsWith('/summary-automation/')) return reply({ available: false, enabled: false, can_control: false })
    if (url.pathname.endsWith('/questions/')) return reply({ available: false, recent: [] })
    return reply({ id: 'test-record', title: '项目评审录音', origin_at: new Date().toISOString(), revision: 2,
      capabilities: { read_summary: true, read_transcript: true, generate_summary: true } })
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
    const { QueryClient, QueryClientProvider } = await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(Recorder, { viewerId: 'ui-test-owner', available: true })))
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
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1)
  await page.getByLabel('播放速度').selectOption('1.5')
  assert.equal(await page.locator('audio').evaluate((audio) => audio.playbackRate), 1.5)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  assert.equal(await page.locator('audio').getAttribute('src'), null)
  await page.getByRole('button', { name: '转写录音', exact: true }).click()
  await page.getByText('用于界面验证的模拟转写结果。').waitFor()
  await page.getByRole('button', { name: '回听 0:01', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime >= 1)
  await page.screenshot({ path: 'test-results/capture-transcript.png', fullPage: true })
  await page.getByText('智能纪要与问答', { exact: true }).click()
  await page.getByRole('button', { name: '生成 AI 纪要', exact: true }).click()
  await page.getByText('用于界面验证的模拟纪要。', { exact: true }).waitFor()
  await page.getByRole('button', { name: /查看原文.*0:01/ }).click()
  await page.getByText('模拟纪要的原文依据。').waitFor()
  await page.getByRole('button', { name: '回听这段原音', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime >= 1)
  await page.screenshot({ path: 'test-results/capture-summary.png', fullPage: true })
  console.log('Capture UI passed: record, upload, recover, save, play, transcribe intent, published text and source seek (HTTP fixtures, synthetic microphone).')
} finally { await browser.close() }
