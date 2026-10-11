import { createRequire } from 'node:module'
import { createServer as httpServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/$/, '')
const require = createRequire(`${root}/package.json`)
const { chromium, expect } = require('@playwright/test')
const { createServer, transformWithEsbuild } = await import(
  pathToFileURL(`${root}/node_modules/vite/dist/node/index.js`)
)
const recordId = '11111111-1111-4111-8111-111111111111'
const version = '22222222-2222-4222-8222-222222222222'
const snapshot = '33333333-3333-4333-8333-333333333333'
const owner = '44444444-4444-4444-8444-444444444444'
const port = Number(process.env.SPEAKER_SUMMARY_REVIEW_PORT || 5319)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local review port.')
const origin = `http://127.0.0.1:${port}`
let revoked = false,
  missing = false
const reads = [],
  unexpected = [],
  blocked = [],
  errors = [],
  cases = []
const content = (kind) => ({
  overview: `Frozen original ${kind} identity`,
  decisions: [],
  chapters: [],
  action_items: [],
  open_questions: [],
})
const config = {
  is_silent_login_enabled: false,
  meeting_records: { enabled: true },
  subtitle: { enabled: false },
  telephony: { enabled: false },
  calendar: { enabled: false },
  background_image: { upload_is_enabled: false },
  livekit: { url: '', default_sources: [] },
  feedback: { url: '' },
}
const api = httpServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://fixture'),
    path = url.pathname.replace('/api/v1.0/', '')
  reads.push({ method: req.method, path, query: url.search })
  let value,
    status = 200
  const recordPath = `meeting-records/${recordId}/`
  if (path === 'config/') value = config
  else if (path === 'users/me' || path === 'users/me/')
    value = {
      id: owner,
      full_name: 'Fixture reviewer',
      language: 'zh',
      timezone: 'Asia/Shanghai',
      email: '',
      last_name: '',
    }
  else if (revoked) {
    status = 404
    value = { detail: 'Fixture access revoked' }
  } else if (path === recordPath)
    value = {
      id: recordId,
      title: 'Historical identity fixture',
      source_type: 'audio_recording',
      origin_at: '2026-10-11T00:00:00Z',
      revision: 4,
      retention_mode: 'text',
      capabilities: {
        read_summary: true,
        read_transcript: false,
        play_media: false,
        generate_summary: false,
      },
    }
  else if (path === `${recordPath}document-exports/`)
    value = { available: false, results: [] }
  else if (path === `${recordPath}summary-job/`)
    value = { available: false, generation_ready: false, job: null }
  else if (
    path === `${recordPath}summary-notifications/` &&
    url.searchParams.get('summary_id') === version
  )
    value = {
      available: false,
      strategy: 'owner',
      legacy_delivery_unchanged: false,
      results: [],
    }
  else if (
    path === `${recordPath}summary-versions/` &&
    url.searchParams.get('version_id') === version
  ) {
    if (missing) {
      status = 404
      value = { detail: 'Missing pinned version' }
    } else
      value = {
        results: [
          {
            id: version,
            stage: 'final',
            input_snapshot_id: snapshot,
            input_revision: 1,
            source_observed_at: '2026-10-11T00:00:00Z',
            source_segment_count: 1,
            source_through_ms: 1000,
            is_current: false,
            identity_updated: true,
            created_at: '2026-10-11T00:00:00Z',
            delivery_status: 'complete',
            asr_status: 'succeeded',
            coverage_status: 'complete',
            content: content('AI'),
          },
        ],
        next_cursor: null,
      }
  } else if (path === `${recordPath}human-summary/history/${version}/`) {
    if (missing) {
      status = 404
      value = { detail: 'Missing pinned version' }
    } else
      value = {
        id: version,
        revision: 1,
        input_snapshot_id: snapshot,
        identity_updated: true,
        created_at: '2026-10-11T00:00:00Z',
        content: content('human'),
      }
  } else if (path === `${recordPath}collaboration/minutes/preview/`) {
    const kind = url.searchParams.has('human_id') ? 'human' : 'summary'
    if (url.searchParams.get(`${kind}_id`) !== version || missing) {
      status = 404
      value = { detail: 'Missing pinned preview' }
    } else
      value = {
        record_id: recordId,
        scope: 'minutes',
        role: 'reader',
        [`${kind}_id`]: version,
        identity_updated: true,
        excerpt: content(kind === 'summary' ? 'AI' : 'human').overview,
        media_type: 'audio',
        media_url: null,
      }
  } else {
    unexpected.push({ method: req.method, path, query: url.search })
    status = 404
    value = { detail: 'Unexpected fixture route' }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${api.address().port}`
const harness = `import React,{Suspense} from 'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{Route,Switch,useLocation}from'wouter';
import '/src/styles/index.css';import '/src/i18n/init';
import{MeetingRecordWorkspace}from'/src/features/meetings/routes/MeetingRecordWorkspace';
import{MeetingRecordCardMessage}from'/src/features/im/components/MeetingRecordCardMessage';
import{meetingRecordLink}from'/src/features/im/components/meetingRecordCard';
import{setTokens}from'/src/features/auth/utils/tokenStorage';
localStorage.setItem('i18nextLng','zh');setTokens({accessToken:'isolated-synthetic-fixture'});
navigator.clipboard.writeText=async(value)=>{window.fixtureCopied=value};
function Chat(){const[,navigate]=useLocation();return <div>{['human','summary'].map(kind=><div data-kind={kind} key={kind}><MeetingRecordCardMessage body={JSON.stringify({v:1,record_id:'${recordId}',title:'Shared '+kind+' history',scope:'minutes',[kind+'_id']:'${version}'})} onOpen={card=>navigate(meetingRecordLink(card))}/></div>)}</div>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Suspense fallback={null}><Switch><Route path='/fixture-chat'><Chat/></Route><Route path='/meeting/records/:recordId'><MeetingRecordWorkspace/></Route></Switch></Suspense></QueryClientProvider>);`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [
    {
      name: 'isolated-pinned-summary-review',
      resolveId(id) {
        if (id === 'virtual:pinned-summary-review.tsx')
          return '\0virtual:pinned-summary-review.tsx'
      },
      async load(id) {
        if (id === '\0virtual:pinned-summary-review.tsx')
          return (
            await transformWithEsbuild(harness, 'pinned-summary-review.tsx', {
              loader: 'tsx',
              jsx: 'transform',
            })
          ).code
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (
            !(
              req.url.startsWith('/fixture-chat') ||
              req.url.startsWith('/meeting/records/')
            )
          )
            return next()
          const html = await server.transformIndexHtml(
            req.url,
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100vh;display:flex;flex-direction:column"></div><script type="module" src="/@id/virtual:pinned-summary-review.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
const artifact =
  process.env.SPEAKER_SUMMARY_REVIEW_ARTIFACT_DIR ||
  `${root}/test-results/speaker-summary-sharing`
await mkdir(artifact, { recursive: true })
const locale = JSON.parse(
  await readFile(`${root}/src/locales/zh/meetings.json`, 'utf8')
)
let browser
try {
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  for (const size of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: size,
      locale: 'zh-CN',
    })
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname
      if (['127.0.0.1', 'localhost'].includes(host)) return route.continue()
      blocked.push(host)
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    for (const kind of ['human', 'summary']) {
      revoked = missing = false
      const start = reads.length
      await page.goto(`${origin}/fixture-chat`)
      const expected = content(kind === 'human' ? 'human' : 'AI').overview
      await expect(
        page.locator(`[data-kind="${kind}"]`).getByText(expected)
      ).toBeVisible()
      await page
        .locator(
          `[data-kind="${kind}"] [data-testid="im-msg-meeting-record-card"]`
        )
        .click()
      await expect(page).toHaveURL(new RegExp(`\\?${kind}=${version}$`))
      await expect(page.getByText(expected, { exact: true })).toBeVisible()
      await expect(
        page.getByText(locale.recordAi.identityUpdated, { exact: true })
      ).toBeVisible()
      await page
        .getByRole('button', { name: locale.collaboration.share, exact: true })
        .click()
      await page
        .getByRole('button', { name: locale.collaboration.copy, exact: true })
        .click()
      await expect
        .poll(() => page.evaluate(() => window.fixtureCopied))
        .toBe(`${origin}/meeting/records/${recordId}?${kind}=${version}`)
      await page
        .getByRole('button', { name: locale.collaboration.close, exact: true })
        .click()
      await page.screenshot({
        path: `${artifact}/${kind}-${size.width}.png`,
        fullPage: true,
      })
      const relevant = reads
        .slice(start)
        .filter((row) => row.path.startsWith(`meeting-records/${recordId}/`))
      if (
        relevant.some(
          (row) =>
            row.method !== 'GET' ||
            row.path.endsWith('/human-summary/') ||
            row.path.includes('original-segments')
        )
      )
        throw new Error('Sharing broadened reads or wrote data.')
      if (
        kind === 'summary' &&
        relevant
          .filter((row) => row.path.endsWith('summary-versions/'))
          .some((row) => !row.query.includes(`version_id=${version}`))
      )
        throw new Error('Unpinned AI fallback.')
      cases.push({
        kind,
        width: size.width,
        fixedLink: await page.evaluate(() => window.fixtureCopied),
        requests: relevant.length,
      })
      missing = true
      await page.reload()
      await expect(page.getByText(expected, { exact: true })).toHaveCount(0)
      await expect(
        page.getByText(
          kind === 'human'
            ? locale.humanReview.unavailable
            : locale.summaryNotice.versionUnavailable,
          { exact: true }
        )
      ).toBeVisible()
      revoked = true
      await page.reload()
      await expect(
        page.getByRole('heading', {
          name: locale.library.loadError,
          exact: true,
          level: 1,
        })
      ).toBeVisible()
      await expect(
        page.getByText('Historical identity fixture', { exact: false })
      ).toHaveCount(0)
      await expect(page.getByText(expected, { exact: true })).toHaveCount(0)
    }
    await context.close()
  }
  if (errors.length || unexpected.length)
    throw new Error(JSON.stringify({ errors, unexpected }))
  const result = {
    cases,
    blockedExternalRequests: blocked,
    pageErrors: errors,
    unexpected,
    apiRequests: reads.length,
    writes: reads.filter((row) => row.method !== 'GET').length,
  }
  await writeFile(
    `${artifact}/result.json`,
    JSON.stringify(result, null, 2),
    'utf8'
  )
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await vite.close()
  await new Promise((resolve) => api.close(resolve))
}
