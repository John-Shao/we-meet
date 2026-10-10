/** Isolated browser review: synthetic local audio, no microphone or cloud calls. */
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, expect } from '@playwright/test'
import { createServer, transformWithEsbuild } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const OWNER = '11111111-1111-4111-8111-111111111111'
const CAPTURE = '22222222-2222-4222-8222-222222222222'
const ASR = '33333333-3333-4333-8333-333333333333'
const JOB = '44444444-4444-4444-8444-444444444444'
const RECORD = '55555555-5555-4555-8555-555555555555'
const wav = Buffer.alloc(320044)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(32000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 0; i < 160000; i++)
  wav.writeInt16LE(
    Math.round(2000 * Math.sin((i / 16000) * 2 * Math.PI * 440)),
    44 + i * 2
  )
const chunks = [0, 1, 2].map((i) => ({
  id: `chunk-${i + 1}`,
  sequence: i + 1,
  start_ms: i * 10000,
  duration_ms: 10000,
  stored: true,
  byte_size: wav.length,
  checksum: createHash('sha256').update(wav).digest('hex'),
}))
let origin = '',
  created = false,
  published = false
const paid = [],
  originals = [],
  downloads = [],
  errors = [],
  blocked = []
const job = () => ({
  id: JOB,
  generation: 1,
  status: published ? 'succeeded' : 'queued',
  source_transcription_id: ASR,
  source_revision: 1,
  published_count: published ? 2 : 0,
})
const state = () => ({
  available: true,
  can_start: !created,
  record_revision: published ? 2 : 1,
  source_transcription_id: ASR,
  active_job_id: published ? JOB : null,
  results: created ? [job()] : [],
})
const api = httpServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner,idempotency-key'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://fixture')
  const path = url.pathname.replace('/api/v1.0/', '')
  let value,
    status = 200
  if (path === `capture-sessions/${CAPTURE}/diarization/`) {
    if (req.method === 'POST') {
      let body = ''
      for await (const part of req) body += part
      paid.push({
        body: JSON.parse(body),
        nonce: req.headers['idempotency-key'],
        owner: req.headers['x-voiceprint-owner'],
      })
      created = true
      // Simulate a committed request whose response was lost, then exact replay.
      if (paid.length === 1) {
        status = 502
        value = { code: 'fixture_response_lost' }
      } else
        value = {
          job: job(),
          created: false,
          command_receipt: {
            key: req.headers['idempotency-key'],
            scope: { capture_id: CAPTURE },
          },
        }
    } else value = state()
  } else if (path === `capture-sessions/${CAPTURE}/transcription/`) {
    value = {
      available: true,
      diarization_available: true,
      active_job_id: ASR,
      active_diarization_job_id: published ? JOB : null,
      results: [
        {
          id: ASR,
          generation: 1,
          status: 'succeeded',
          mode: 'sealed',
          final_count: 2,
        },
      ],
    }
  } else if (path === `meeting-records/${RECORD}/original-segments/`) {
    originals.push(url.search)
    value = {
      results: [
        {
          id: published ? 'derived-row' : 'base-row',
          start_ms: 9500,
          end_ms: 10500,
          speaker_label: url.searchParams.has('diarization_job_id')
            ? '说话人 1'
            : null,
          text: url.searchParams.has('diarization_job_id')
            ? '分人后的原文'
            : '尚未分人的原文',
        },
      ],
      next_cursor: null,
    }
  } else if (path === `capture-sessions/${CAPTURE}/audio/`) {
    value = {
      results: url.searchParams.get('after_sequence') === '0' ? chunks : [],
      manifest: null,
      next_after_sequence: null,
    }
  } else if (path.startsWith(`capture-sessions/${CAPTURE}/audio/chunk-`)) {
    downloads.push(path)
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': wav.length,
    })
    res.end(wav)
    return
  } else {
    status = 404
    value = { code: 'fixture_route_unavailable' }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${api.address().port}`
const harness = `import React,{Suspense,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '/src/styles/index.css';import '/src/i18n/init';
import {CaptureTranscriptionPanel} from '/src/features/meetings/components/CaptureTranscriptionPanel';
import {CaptureAudioPlayer} from '/src/features/meetings/components/CaptureAudioPlayer';
import {TranscriptDraftScope} from '/src/features/meetings/components/TranscriptDraftScope';
import {setTokens} from '/src/features/auth/utils/tokenStorage';
setTokens({accessToken:'synthetic-fixture'});localStorage.setItem('i18nextLng','zh');
function Review(){const player=useRef(null);window.captureReview={preview:()=>player.current.preview(9500,10500),
stop:()=>player.current.stopPreview(),switchLogin:()=>{setTokens({accessToken:'different-synthetic-login'});window.dispatchEvent(new Event('storage'))}};
return <main style={{maxWidth:960,margin:'auto',padding:16}}><TranscriptDraftScope><CaptureTranscriptionPanel viewerId='${OWNER}'
capture={{id:'${CAPTURE}',record_id:'${RECORD}',status:'stopped',media_status:'saved'}} onSource={ms=>player.current?.seek(ms)}/></TranscriptDraftScope>
<CaptureAudioPlayer ref={player} captureId='${CAPTURE}'/>
<button onClick={()=>void player.current?.preview(9500,10500)}>合成区间试听</button></main>}
createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Suspense fallback={null}><Review/></Suspense></QueryClientProvider></React.StrictMode>);`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'isolated-capture-review',
      resolveId(id) {
        if (id === 'virtual:capture-review.tsx')
          return '\0virtual:capture-review.tsx'
      },
      async load(id) {
        if (id === '\0virtual:capture-review.tsx')
          return transformWithEsbuild(harness, 'capture-review.tsx', {
            loader: 'tsx',
            jsx: 'automatic',
          })
      },
      configureServer(server) {
        server.middlewares.use('/__capture-review/', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/__capture-review/',
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:capture-review.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
const artifacts =
  process.env.VOICEPRINT_REVIEW_ARTIFACT_DIR ||
  join(tmpdir(), 'we-meet-capture-diarization-review')
await mkdir(artifacts, { recursive: true })
let browser
try {
  await vite.listen()
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (
      url.origin === origin ||
      url.origin === process.env.VITE_API_BASE_URL ||
      ['blob:', 'data:'].includes(url.protocol)
    )
      return route.continue()
    blocked.push(url.hostname)
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${origin}/__capture-review/`)
  const controls = page.getByRole('region', {
    name: '录音说话人分离',
    exact: true,
  })
  await expect(controls.getByRole('checkbox')).toBeEnabled({ timeout: 90000 })
  await expect(page.getByText('尚未分人的原文', { exact: true })).toBeVisible()
  expect(paid).toHaveLength(0)
  await expect(
    controls.getByRole('button', { name: '开始分人', exact: true })
  ).toBeDisabled()
  await controls
    .getByText('我确认进行说话人处理，可能产生费用。取消任务不保证退费。', {
      exact: true,
    })
    .click()
  await expect(controls.getByRole('checkbox')).toBeChecked()
  await controls.getByRole('button', { name: '开始分人', exact: true }).click()
  await expect(
    controls.getByRole('button', { name: '恢复同一请求', exact: true })
  ).toBeEnabled()
  expect(paid).toHaveLength(1)
  await page.screenshot({ path: join(artifacts, 'desktop-recovery.png') })
  await controls
    .getByRole('button', { name: '恢复同一请求', exact: true })
    .click()
  await expect(
    controls.getByRole('button', { name: '恢复同一请求', exact: true })
  ).toHaveCount(0)
  await expect(controls.getByRole('alert')).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).some((key) =>
        key.startsWith('capture-diarization:')
      )
    )
  ).toBe(false)
  await expect(
    controls.getByRole('button', { name: '取消处理', exact: true })
  ).toBeEnabled()
  expect(paid).toHaveLength(2)
  expect(paid[1]).toEqual(paid[0])
  expect(paid[0].owner).toBe(OWNER)
  expect(paid[0].body).toEqual({ expected_revision: 1 })
  published = true
  await controls.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect(page.getByText('分人后的原文', { exact: true })).toBeVisible()
  await expect(page.getByText('说话人 1', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      '说话人已分离。点击时间戳试听原音，可在说话人页标记并确认身份。',
      { exact: true }
    )
  ).toBeVisible()
  expect(
    originals.some((q) =>
      q.includes(`transcription_job_id=${ASR}&diarization_job_id=${JOB}`)
    )
  ).toBe(true)
  await page.getByRole('button', { name: '合成区间试听', exact: true }).click()
  await expect.poll(() => downloads.length).toBe(2)
  await expect.poll(() => page.locator('audio').getAttribute('src')).toBeNull()
  expect(downloads.some((p) => p.includes('chunk-3'))).toBe(false)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    await page.screenshot({
      path: join(artifacts, `${width}-published.png`),
      fullPage: true,
    })
  }
  await page.evaluate(() => window.captureReview.switchLogin())
  await expect(controls).toHaveCount(0)
  await expect(page.locator('audio')).not.toHaveAttribute('src')
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).some((key) =>
        key.startsWith('capture-diarization:')
      )
    )
  ).toBe(false)
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        paidRequests: paid.length,
        exactReplay: paid[0].nonce === paid[1].nonce,
        currentVersionPinned: true,
        previewDownloads: downloads.length,
        previewCleared: true,
        accountFence: true,
        viewports: [1280, 390],
        errors,
        blocked,
      },
      null,
      2
    )
  )
  console.log(`Capture browser review passed; artifacts: ${artifacts}`)
} catch (error) {
  process.exitCode = 1
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      { passed: false, error: String(error), errors, blocked },
      null,
      2
    )
  )
  console.error(error)
} finally {
  await browser?.close()
  await vite.close()
  await new Promise((resolve) => api.close(resolve))
}
