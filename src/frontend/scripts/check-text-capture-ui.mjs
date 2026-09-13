// Chromium UI fixture with synthetic audio; never calls a real provider/backend.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
})
try {
  const context = await browser.newContext({
    permissions: ['microphone'],
    locale: 'zh-CN',
  })
  const chunks = new Map()
  let remote
  let job
  const retention = {
    mode: 'text',
    temporary_until: new Date(Date.now() + 86400000).toISOString(),
    retry_until: new Date(Date.now() + 86400000).toISOString(),
    expired: false,
    cleanup_status: 'not_started',
    cleanup_error: '',
    deleted_at: null,
  }
  await context.route('**/text-recording-ui', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div></html>',
    })
  )
  await context.route('**/api/v1.0/capture-audio-capabilities/', (route) =>
    route.fulfill({
      json: { text_audio_available: true, text_audio_error: '' },
    })
  )
  await context.route('**/api/v1.0/capture-sessions/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.split('/capture-sessions/')[1]
    const reply = (json, status = 200) => route.fulfill({ json, status })
    if (!path) {
      const body = req.postDataJSON()
      assert.equal(body.retention_mode, 'text')
      remote = {
        id: randomUUID(),
        record_id: randomUUID(),
        device_id: body.device_id,
        status: 'preparing',
        revision: 1,
        started_at: new Date().toISOString(),
        ended_at: null,
        media_status: 'not_connected',
        captured_duration_ms: null,
        last_acked_sequence: 0,
        missing_ranges: null,
        coverage_status: 'unverified',
        audio_retention: retention,
      }
      return reply(
        {
          capture: remote,
          result: remote,
          operation_id: randomUUID(),
          replayed: false,
        },
        201
      )
    }
    if (path.endsWith('/commands/')) {
      const command = req.postDataJSON().command
      remote.status = {
        start: 'recording',
        stop: 'stopping',
        finalize: 'stopped',
      }[command]
      assert.ok(remote.status)
      remote.revision++
      if (command === 'finalize') {
        remote.ended_at = new Date().toISOString()
        retention.retry_until = new Date(Date.now() + 1800000).toISOString()
      }
      return reply({
        capture: remote,
        result: remote,
        operation_id: randomUUID(),
        replayed: false,
      })
    }
    if (path.endsWith('/audio/upload/')) {
      const form = await new Response(req.postDataBuffer(), {
        headers: { 'Content-Type': req.headers()['content-type'] },
      }).formData()
      const audio = Buffer.from(await form.get('audio').arrayBuffer())
      assert.equal(
        createHash('sha256').update(audio).digest('hex'),
        form.get('checksum')
      )
      const receipt = {
        id: randomUUID(),
        sequence: Number(form.get('sequence')),
        start_ms: Number(form.get('start_ms')),
        duration_ms: audio.readUInt32LE(40) / 32,
        checksum: form.get('checksum'),
        byte_size: audio.length,
        stored: true,
      }
      chunks.set(receipt.sequence, receipt)
      return reply(receipt)
    }
    if (path.endsWith('/audio/'))
      return reply({ results: [...chunks.values()], next_after_sequence: null })
    if (path.endsWith('/audio/seal/')) {
      remote.media_status = 'saved'
      return reply({
        ...req.postDataJSON(),
        outcome: 'saved',
        duration_ms: 5000,
        missing_sequences: [],
        gaps: [],
        coverage_status: 'unverified',
      })
    }
    if (path.endsWith('/transcription/')) {
      if (req.method() === 'POST') {
        job = {
          id: randomUUID(),
          generation: 1,
          status: 'succeeded',
          input_count: chunks.size,
          acknowledged_inputs: chunks.size,
          final_count: 1,
        }
        retention.cleanup_status = 'failed'
        retention.cleanup_error = 'storage_unavailable'
        return reply({ job }, 201)
      }
      return reply({
        available: true,
        live_available: true,
        active_job_id: job?.id ?? null,
        results: job ? [job] : [],
        audio_retention: retention,
      })
    }
    assert.equal(path, `${remote.id}/`)
    return reply(remote)
  })
  await context.route('**/api/v1.0/meeting-records/**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: randomUUID(),
            start_ms: 1000,
            text: '文字模式测试：保留已确认的会议结论。',
          },
        ],
        next_cursor: null,
      },
    })
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/text-recording-ui`)
  await page.evaluate(async () => {
    const runtime = (await import('/@react-refresh')).default
    runtime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => undefined
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    await import('/src/styles/index.css')
    await import('/src/i18n/init.ts')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (
      await import('/node_modules/.vite/deps/react-dom_client.js')
    ).default
    const { Recorder } =
      await import('/src/features/meetings/routes/AudioRecording.tsx')
    const { QueryClient, QueryClientProvider } =
      await import('/node_modules/.vite/deps/@tanstack_react-query.js')
    createRoot(document.getElementById('root')).render(
      React.createElement(
        React.Suspense,
        { fallback: 'Loading' },
        React.createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          React.createElement(Recorder, {
            viewerId: 'text-ui-fixture',
            available: true,
          })
        )
      )
    )
  })
  const choice = page.getByRole('checkbox', { name: '仅保留文字', exact: true })
  await choice.waitFor()
  assert.equal(await choice.isChecked(), false)
  await choice.check()
  await page.getByLabel('录音名称').fill('客户访谈 · 仅保留文字')
  await page.screenshot({
    path: 'test-results/text-capture-consent.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  await page.waitForFunction(
    () => document.body.textContent.includes('本机已记录 0:05'),
    null,
    { timeout: 15000 }
  )
  await page.getByRole('button', { name: '结束并保存', exact: true }).click()
  await page.getByRole('button', { name: '转写录音', exact: true }).click()
  await page.getByText('文字模式测试：保留已确认的会议结论。').waitFor()
  await page
    .getByText('临时音频清理尚未完成，系统将继续重试。', { exact: true })
    .waitFor()
  assert.equal(
    await page.getByRole('button', { name: '播放', exact: true }).count(),
    0
  )
  assert.equal(await page.getByRole('button', { name: /回听/ }).count(), 0)
  await page.screenshot({
    path: 'test-results/text-capture-cleanup.png',
    fullPage: true,
  })
  retention.cleanup_status = 'complete'
  retention.cleanup_error = ''
  retention.deleted_at = new Date().toISOString()
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await page
    .getByText('临时音频已删除，文字和纪要已保留。', { exact: true })
    .waitFor()
  assert.deepEqual(errors, [])
  console.log(
    'Text recording UI passed: explicit consent, recording, transcription, failed/completed cleanup, no audio playback/download.'
  )
} finally {
  await browser.close()
}
