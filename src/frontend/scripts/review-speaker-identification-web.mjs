/** Actual record workspace + real browser media; synthetic HTTP contracts only. */
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createServer as httpServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const OWNER = '11111111-1111-4111-8111-111111111111',
  RECORD = '22222222-2222-4222-8222-222222222222',
  ORG = '44444444-4444-4444-8444-444444444444',
  MEMBER = '55555555-5555-4555-8555-555555555555',
  READER = '99999999-9999-4999-8999-999999999999'
const speakers = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
]
const names = ['Synthetic Reviewer', 'Synthetic Participant']
let revision = 1,
  batch,
  readonly = false,
  conflict = false,
  submissions = 0,
  decisions = 0,
  reads = 0
const requests = [],
  errors = [],
  blocked = [],
  overflows = []
const attributed = new Map()
const config = {
  is_silent_login_enabled: false,
  subtitle: { enabled: false },
  telephony: { enabled: false },
  calendar: { enabled: false },
  background_image: { upload_is_enabled: false },
  livekit: { url: '', default_sources: [] },
  feedback: { url: '' },
  meeting_records: { enabled: true, summary_requests_enabled: false },
  speaker_identity: { enabled: true, matching_enabled: true },
}
const metadata = () => ({
  id: RECORD,
  source_type: 'upload',
  source_session_id: null,
  meeting_session_id: null,
  title: 'Synthetic identity review',
  revision,
  lifecycle_revision: 1,
  origin_at: '2026-10-10T00:00:00Z',
  retention_mode: 'media',
  source_available: true,
  is_ongoing: false,
  has_summary: false,
  capture_id: null,
  owner: names[0],
  media_timing: {
    duration_ms: 40000,
    saved_duration_ms: 40000,
    basis: 'sealed_upload',
  },
  upload: {
    status: 'succeeded',
    name: 'synthetic.wav',
    size: 1920044,
    media_type: 'audio',
    can_control: false,
  },
  capabilities: {
    read_summary: true,
    read_transcript: true,
    play_media: !readonly,
    download_media: !readonly,
    edit: !readonly,
    rename: !readonly,
    batch_correct: !readonly,
    manage: false,
    capture: false,
    generate_summary: false,
  },
})
function published() {
  if (!batch) return { record_revision: revision, request: null }
  const copy = structuredClone(batch)
  copy.processing =
    reads < 2 &&
    !copy.jobs.every((job) => job.suggestion?.state === 'confirmed')
  if (!copy.processing)
    for (let i = 0; i < copy.jobs.length; i++) {
      const job = copy.jobs[i]
      if (!job.suggestion) {
        job.status = 'succeeded'
        job.suggestion = {
          id: `88888888-8888-4888-8888-88888888888${i + 1}`,
          state: 'pending',
          result: 'suggested',
          reason: 'all_clips_agree',
          clip_count: 3,
          speech_ms: 11400,
          query_intervals: [0, 10000, 20000].map((start) => ({
            start_ms: start + i * 5000 + 100,
            end_ms: start + i * 5000 + 3900,
          })),
          can_confirm: true,
          verification_unavailable: false,
          candidate: { id: i === 0 ? OWNER : MEMBER, name: names[i] },
        }
      }
    }
  batch = structuredClone(copy)
  return { record_revision: revision, request: copy }
}
const wav = Buffer.alloc(44 + 24000 * 40 * 2)
wav.write('RIFF', 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24)
wav.writeUInt32LE(48000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 0; i < 24000 * 40; i++)
  wav.writeInt16LE(
    Math.round(500 * Math.sin((i * Math.PI * 2 * 160) / 24000)),
    44 + i * 2
  )

const api = httpServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://fixture'),
    path = url.pathname.replace('/api/v1.0/', '')
  if (url.pathname === '/synthetic.wav') {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Number(range[2]) : wav.length - 1
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Accept-Ranges', 'bytes')
    if (range)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${wav.length}`)
    res.setHeader('Content-Length', end - start + 1)
    res.writeHead(range ? 206 : 200)
    res.end(wav.subarray(start, end + 1))
    return
  }
  requests.push({ path, method: req.method })
  let value,
    status = 200
  const prefix = `meeting-records/${RECORD}/`
  const actor = readonly ? READER : OWNER
  if (path === 'config/') value = config
  else if (path.startsWith('users/me'))
    value = {
      id: actor,
      email: '',
      full_name: readonly ? 'Synthetic Reader' : names[0],
      last_name: '',
      language: 'zh-hans',
      timezone: 'Asia/Shanghai',
    }
  else if (
    path.startsWith(prefix) &&
    (path.includes('speaker-identification') ||
      path.includes('identity-decision')) &&
    (readonly || req.headers['x-voiceprint-owner'] !== OWNER)
  ) {
    status = 401
    value = { code: 'voiceprint_account_changed' }
  } else if (path === prefix) value = metadata()
  else if (path === `${prefix}media/`)
    value = {
      url: `http://127.0.0.1:${api.address().port}/synthetic.wav`,
      expires_in: 6000,
      media_type: 'audio',
      name: 'synthetic.wav',
      size: wav.length,
      content_type: 'audio/wav',
    }
  else if (path === `${prefix}speakers/`)
    value = {
      next_cursor: null,
      results: speakers.map((id, i) => ({
        id,
        label: `Speaker ${i}`,
        identity_type: 'diarized',
        rows: 3,
        display_name: attributed.get(id) ?? `Speaker ${i}`,
        manual_label: '',
        attribution_kind: attributed.has(id) ? 'member' : 'none',
        attributed_user_id: attributed.has(id)
          ? i === 0
            ? OWNER
            : MEMBER
          : null,
        record_revision: revision,
        can_attribute: !readonly,
      })),
    }
  else if (path === `${prefix}original-segments/`)
    value = {
      next_cursor: null,
      results: speakers.map((id, i) => ({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i + 1}`,
        revision: 1,
        capture_session_id: ORG,
        source_track_id: 'uploaded-file',
        source_sequence: i + 1,
        start_ms: i * 5000,
        end_ms: i * 5000 + 4000,
        speaker_id: id,
        speaker_label: attributed.get(id) ?? `Speaker ${i}`,
        text: 'Synthetic transcript; no human recording.',
        language: 'en',
        can_correct: false,
      })),
    }
  else if (path === `${prefix}speaker-identification-options/`)
    value = {
      record_revision: revision,
      required_organization_id: null,
      personal_allowed: true,
      targets: speakers
        .filter((id) => !attributed.has(id))
        .map((id) => ({ id, name: `Speaker ${speakers.indexOf(id)}` })),
      scopes: {
        results: [{ id: ORG, name: 'Synthetic organization', enabled: true }],
        next_offset: null,
      },
    }
  else if (path === `${prefix}speaker-identification-candidates/`)
    value = {
      record_revision: revision,
      organization_id:
        url.searchParams.get('organization_id') === 'personal' ? null : ORG,
      results:
        url.searchParams.get('organization_id') === 'personal'
          ? [{ id: OWNER, name: names[0] }]
          : [
              { id: OWNER, name: names[0] },
              { id: MEMBER, name: names[1] },
            ],
      next_offset: null,
    }
  else if (path === `${prefix}speaker-identification/`) {
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const input = JSON.parse(body)
      expect(input.organization_id).toBe(ORG)
      expect(new Set(input.user_ids)).toEqual(new Set([OWNER, MEMBER]))
      expect(new Set(input.speaker_ids)).toEqual(new Set(speakers))
      submissions++
      reads = 0
      batch = {
        id: ORG,
        request_key: input.request_key,
        organization_id: ORG,
        source_revision: revision,
        created_at: new Date().toISOString(),
        processing: true,
        jobs: speakers.map((speaker_id, i) => ({
          id: `77777777-7777-4777-8777-77777777777${i + 1}`,
          speaker_id,
          status: 'queued',
          retryable: false,
          suggestion: null,
        })),
      }
      status = 202
    } else if (req.method === 'GET') reads++
    value = published()
  } else if (path.includes('/identity-decision/')) {
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body),
      id = path.split('/')[3]
    if (conflict) {
      conflict = false
      revision++
      status = 409
      value = { code: 'identity_revision_changed' }
    } else {
      expect(input.expected_revision).toBe(revision)
      expect(input.action).toBe('confirm_suggestion')
      const job = batch.jobs.find((job) => job.speaker_id === id)
      expect(input.suggestion_id).toBe(job.suggestion.id)
      attributed.set(id, job.suggestion.candidate.name)
      revision++
      decisions++
      job.suggestion.state = 'confirmed'
      job.suggestion.candidate = null
      job.suggestion.can_confirm = false
      job.suggestion.query_intervals = []
      value = {
        id,
        display_name: attributed.get(id),
        record_revision: revision,
      }
    }
  } else if (
    path.startsWith(prefix) &&
    /summaries|summary-versions|overview-versions|documents|translation/.test(
      path
    )
  )
    value = { results: [], next_cursor: null }
  else {
    status = 404
    value = { code: 'fixture_route_unavailable' }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${api.address().port}`
const harness = `import React,{Suspense} from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import'/src/styles/index.css';import'/src/i18n/init';import{RecordWorkspace}from'/src/features/meetings/routes/MeetingRecordWorkspace';import{setTokens}from'/src/features/auth/utils/tokenStorage';setTokens({accessToken:'synthetic-review'});localStorage.setItem('i18nextLng','zh');const viewerId=new URLSearchParams(location.search).has('readonly')?'${READER}':'${OWNER}';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(Suspense,{fallback:null},React.createElement(RecordWorkspace,{viewerId,recordId:'${RECORD}'})))));`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 5189, strictPort: true },
  plugins: [
    {
      name: 'speaker-identity-review',
      resolveId(id) {
        if (id === 'virtual:speaker-identity-review.tsx')
          return '\0virtual:speaker-identity-review.tsx'
      },
      load(id) {
        if (id === '\0virtual:speaker-identity-review.tsx') return harness
      },
      configureServer(server) {
        server.middlewares.use('/__speaker-review/', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/__speaker-review/',
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:speaker-identity-review.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
const artifacts =
  process.env.VOICEPRINT_REVIEW_ARTIFACT_DIR ??
  join(tmpdir(), 'we-meet-speaker-identification-review')
await mkdir(artifacts, { recursive: true })
let browser, page
try {
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    if (['127.0.0.1', 'localhost'].includes(host)) return route.continue()
    blocked.push(host)
    return route.abort()
  })
  await context.routeWebSocket('**', (socket) => socket.close())
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('Human media is forbidden in this synthetic review')
    }
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5189/__speaker-review/')
  const tab = page.getByRole('tab', { name: '发言人', exact: true })
  await expect(tab.first()).toBeVisible({ timeout: 90000 })
  await tab.first().click()
  const open = page.getByRole('button', { name: '选择候选并识别', exact: true })
  await expect(open).toBeVisible({ timeout: 90000 })
  expect(
    requests.filter((entry) => entry.path.includes('speaker-identification'))
  ).toHaveLength(0)
  await open.click()
  const panel = page.locator('section[aria-label="识别说话人身份"]')
  await expect(panel.getByLabel('声纹库', { exact: true })).toBeVisible()
  await panel.getByLabel('声纹库', { exact: true }).selectOption(ORG)
  await panel.getByRole('checkbox', { name: names[0], exact: true }).check()
  await panel.getByRole('checkbox', { name: names[1], exact: true }).check()
  await panel
    .getByRole('button', { name: '识别所选说话人', exact: true })
    .click()
  await expect(
    panel.getByText('建议身份：Synthetic Reviewer', { exact: true })
  ).toBeVisible({ timeout: 20000 })
  expect(submissions).toBe(1)
  await panel
    .getByRole('button', { name: '试听片段 1', exact: true })
    .first()
    .click()
  await expect
    .poll(() => page.locator('audio').evaluate((el) => el.paused))
    .toBe(false)
  await expect
    .poll(() => page.locator('audio').evaluate((el) => el.paused), {
      timeout: 8000,
    })
    .toBe(true)
  expect(
    await page.locator('audio').evaluate((el) => Math.abs(el.currentTime - 3.9))
  ).toBeLessThan(0.1)
  for (const [name, width, font, theme] of [
    ['desktop-light', 1280, '', 'light'],
    ['desktop-dark', 1280, '', 'dark'],
    ['mobile-light', 390, '', 'light'],
    ['mobile-dark', 390, '', 'dark'],
    ['mobile-large-light', 390, '24px', 'light'],
    ['mobile-large-dark', 390, '24px', 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(
      ({ font, theme }) => {
        document.documentElement.style.fontSize = font
        document.documentElement.setAttribute('data-theme', theme)
      },
      { font, theme }
    )
    if (await tab.count()) await tab.first().click()
    // Workspace panels scroll inside their ancestors. Element screenshots of
    // a tall panel include clipped blank areas; capture the visible viewport
    // at both the form and the suggestions instead.
    await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: `${artifacts}/${name}.png` })
    const suggestion = panel.getByText('建议身份：Synthetic Reviewer', {
      exact: true,
    })
    await suggestion.scrollIntoViewIfNeeded()
    await expect(suggestion).toBeInViewport()
    await page.screenshot({ path: `${artifacts}/${name}-results.png` })
    const measurements = await panel.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
      docWidth: document.documentElement.clientWidth,
      docScroll: document.documentElement.scrollWidth,
    }))
    overflows.push({ name, ...measurements })
    expect(measurements.scroll).toBeLessThanOrEqual(measurements.width + 1)
    expect(measurements.docScroll).toBeLessThanOrEqual(
      measurements.docWidth + 1
    )
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = ''
    document.documentElement.setAttribute('data-theme', 'light')
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await panel
    .getByRole('button', { name: '确认身份', exact: true })
    .first()
    .click()
  await expect(panel.getByText('身份已确认', { exact: true })).toHaveCount(1)
  conflict = true
  await panel
    .getByRole('button', { name: '确认身份', exact: true })
    .last()
    .click()
  await expect(
    panel.getByText('记录或识别上下文已变化，请刷新后再决定。', { exact: true })
  ).toBeVisible()
  await expect(
    panel.getByText('建议身份：Synthetic Participant', { exact: true })
  ).toHaveCount(0)
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(
    panel.getByText('建议身份：Synthetic Participant', { exact: true })
  ).toBeVisible()
  await panel
    .getByRole('button', { name: '确认身份', exact: true })
    .last()
    .click()
  await expect(panel.getByText('身份已确认', { exact: true })).toHaveCount(2)
  expect(decisions).toBe(2)
  expect(submissions).toBe(1)
  const before = requests.filter((entry) =>
    entry.path.includes('speaker-identification')
  ).length
  readonly = true
  await page.goto('http://127.0.0.1:5189/__speaker-review/?readonly=1')
  await expect(
    page.getByText('Synthetic identity review', { exact: true })
  ).toBeVisible()
  if (await tab.count()) await tab.first().click()
  await expect(open).toHaveCount(0)
  expect(
    requests.filter((entry) => entry.path.includes('speaker-identification'))
      .length
  ).toBe(before)
  expect(
    requests.filter((entry) =>
      /voiceprint\/enroll|transcribe|capture.*start/.test(entry.path)
    )
  ).toHaveLength(0)
  const result = {
    syntheticOnly: true,
    actualWorkspace: true,
    sourcePreviewStopped: true,
    submissions,
    decisions,
    revision,
    readonlyHasNoIdentityRequests: true,
    errors,
    blocked,
    overflows,
  }
  await writeFile(`${artifacts}/result.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
} catch (error) {
  console.log('REVIEW FAILED', error.message)
  if (page) {
    console.log((await page.locator('body').innerText()).slice(0, 5000))
    await page.screenshot({ path: `${artifacts}/failure.png` })
  }
  process.exitCode = 1
} finally {
  await browser?.close()
  vite.httpServer?.closeAllConnections()
  await vite.close()
  api.closeAllConnections()
  await new Promise((resolve) => api.close(resolve))
}
