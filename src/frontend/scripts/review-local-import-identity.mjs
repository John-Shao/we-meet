/** Owned Docker backend + real React components. No API response mocks. */
import { chromium, expect } from '@playwright/test'
import { createServer, transformWithEsbuild } from 'vite'
import { Agent } from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const config = JSON.parse(
  await readFile(process.env.VOICEPRINT_LOCAL_WEB_CONFIG, 'utf8')
)
if (!config.synthetic_import || !Number.isInteger(config.backend_port))
  throw new Error('Owned import fixture configuration required')
const root = fileURLToPath(new URL('../', import.meta.url))
const meetings = JSON.parse(
  await readFile(join(root, 'src/locales/zh/meetings.json'), 'utf8')
)
const identity = JSON.parse(
  await readFile(
    join(root, 'src/locales/zh/speakerIdentification.json'),
    'utf8'
  )
)
const owner = config.users[0]
const base = 'http://127.0.0.1:5319'
process.env.VITE_API_BASE_URL = base
const harness = `
import React,{Suspense,useState,useRef}from'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider,useQuery}from'@tanstack/react-query';import'/src/styles/index.css';import'/src/i18n/init';
import{RecordingUpload,UploadedRecordingStatus}from'/src/features/meetings/components/RecordingUpload';
import{SpeakerIdentificationPanel}from'/src/features/voiceprint/SpeakerIdentificationPanel';
import{SpeakerAttributionControl}from'/src/features/meetings/components/SpeakerAttributionControl';
import{useMeetingRecord,useRecordSpeakers}from'/src/features/meetings/api/fetchMeetingRecord';
import{fetchApi}from'/src/api/fetchApi';
localStorage.setItem('i18nextLng','zh');
const viewer='${owner.id}';
function Text({id,revision}){const q=useQuery({queryKey:['meeting-records',viewer,'original-segments',id,revision],queryFn:({signal})=>fetchApi('meeting-records/'+id+'/original-segments/?expected_revision='+revision,{signal}),retry:false});return <div data-testid="transcript">{q.data?.results.map(s=><p key={s.id}>{s.speaker_label}: {s.text}</p>)}</div>}
function Record({id}){const q=useMeetingRecord(viewer,id,true);const r=q.data;const speakers=useRecordSpeakers(viewer,id,r?.revision,!!r);const rows=useRef([]);if(speakers.data)rows.current=speakers.data.results;return r?<><div data-testid="speakers">{rows.current.map(s=><SpeakerAttributionControl key={s.id} recordId={id} viewerId={viewer} speaker={s}/>)}</div><SpeakerIdentificationPanel record={r} viewerId={viewer} onPreview={async()=>false} onPreviewStop={()=>{}}/>{r.upload?.status==='succeeded'&&<Text id={id} revision={r.revision}/>}</>:null}
function Fixture(){const[id,setId]=useState(null);return <main style={{maxWidth:960,margin:'auto',padding:16}}><h1>Local synthetic import acceptance</h1>{id?<><UploadedRecordingStatus recordId={id} viewerId={viewer}/><Record id={id}/></>:<RecordingUpload viewerId={viewer} onRecord={setId}/>}</main>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Suspense fallback={null}><Fixture/></Suspense></QueryClientProvider>);
`
const agent = new Agent({
  ca: await readFile(config.ca_path),
  servername: 'backend',
})
const vite = await createServer({
  root,
  server: {
    host: '127.0.0.1',
    port: 5319,
    strictPort: true,
    proxy: {
      '/api': {
        target: `https://127.0.0.1:${config.backend_port}`,
        agent,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (req) => {
            req.setHeader('Host', 'backend:8000')
            req.setHeader('Origin', 'https://backend:8000')
          })
        },
      },
    },
  },
  plugins: [
    {
      name: 'real-local-import-review',
      resolveId(id) {
        if (id === 'virtual:local-import-review.tsx') return '\0' + id
      },
      async load(id) {
        if (id === '\0virtual:local-import-review.tsx')
          return (
            await transformWithEsbuild(harness, 'local-import-review.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            })
          ).code
      },
      configureServer(server) {
        server.middlewares.use('/__local-import-review/', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/__local-import-review/',
            '<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:local-import-review.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
let browser, page
const errors = [],
  measurements = []
let uploadCount = 0,
  blocked = 0
function cookies(actor) {
  return [
    { name: config.cookie_name, value: actor.cookie, httpOnly: true },
    { name: config.csrf_cookie_name, value: actor.csrf, httpOnly: false },
  ].map((cookie) => ({
    ...cookie,
    domain: '127.0.0.1',
    path: '/',
    secure: false,
    sameSite: 'Lax',
  }))
}
try {
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  })
  await context.addCookies(cookies(owner))
  await context.route('**/*', (route) => {
    if (
      ['127.0.0.1', 'localhost'].includes(
        new URL(route.request().url()).hostname
      )
    )
      return route.continue()
    blocked++
    return route.abort()
  })
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('Synthetic media only')
    }
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      new URL(req.url()).pathname === '/api/v1.0/recording-uploads/'
    )
      uploadCount++
  })
  await page.goto(base + '/__local-import-review/')
  await expect(
    page.getByRole('button', { name: meetings.upload.open, exact: true })
  ).toBeVisible({ timeout: 90000 })
  await page.locator('input[type=file]').setInputFiles(config.audio_path)
  await page.getByText(meetings.upload.identity, { exact: true }).click()
  await page.getByText('Synthetic RTC fixture', { exact: true }).click()
  const uploaded = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1.0/recording-uploads/'
  )
  await page
    .getByRole('button', { name: meetings.upload.submit, exact: true })
    .click()
  const response = await uploaded
  expect(response.status()).toBe(202)
  const recordId = (await response.json()).record_id
  const api = async (path, data, actor = owner) => {
    const options = {
      headers: { 'X-Voiceprint-Owner': actor.id, 'X-CSRFToken': actor.csrf },
    }
    return data === undefined
      ? context.request.get(base + '/api/v1.0/' + path, options)
      : context.request.post(base + '/api/v1.0/' + path, { ...options, data })
  }
  const recordPath = `meeting-records/${recordId}/`
  await expect
    .poll(
      async () =>
        (await (await api(recordPath + 'speaker-identification/')).json())
          .request?.jobs?.[0]?.suggestion?.result,
      { timeout: 180000, intervals: [1000] }
    )
    .toBe('suggested')
  const initial = await (await api(recordPath + 'speakers/')).json()
  expect(initial.results).toHaveLength(1)
  expect(initial.results[0].attributed_user_id).toBeNull()
  expect(initial.results[0].manual_label).toBe('')
  expect(initial.results[0].attribution_kind).toBe('none')
  await expect(
    page
      .getByTestId('transcript')
      .getByText(/Synthetic import protocol sentence/)
  ).toHaveCount(3, { timeout: 30000 })
  await page.getByRole('button', { name: identity.open, exact: true }).click()
  await expect(
    page.getByText(
      identity.suggested.replace('{{name}}', 'Synthetic RTC fixture'),
      { exact: true }
    )
  ).toBeVisible({ timeout: 30000 })
  await page.screenshot({
    path: join(config.artifacts, 'suggestion-desktop.png'),
    fullPage: true,
  })
  const pending = await (
    await api(recordPath + 'speaker-identification/')
  ).json()
  expect(pending.request.jobs[0].status).toBe('succeeded')
  const suggestionId = pending.request.jobs[0].suggestion.id
  const speakerId = initial.results[0].id
  const decisionPath = recordPath + `speakers/${speakerId}/identity-decision/`
  await page
    .getByRole('button', { name: identity.confirm, exact: true })
    .click()
  await expect(
    page.getByText(identity.decision.confirmed, { exact: true })
  ).toBeVisible()
  const duplicate = await api(decisionPath, {
    action: 'confirm_suggestion',
    suggestion_id: suggestionId,
    expected_revision: pending.record_revision,
  })
  expect(duplicate.status()).toBe(409)
  const speakers = page.getByTestId('speakers')
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.changeFor.replace(
        '{{name}}',
        'Synthetic RTC fixture'
      ),
      exact: true,
    })
    .click()
  await page
    .getByRole('button', {
      name: meetings.speakerAttribution.choose.replace(
        '{{name}}',
        'Synthetic external contact'
      ),
      exact: true,
    })
    .click()
  await expect(
    speakers.getByText('Synthetic external contact', { exact: true })
  ).toBeVisible()
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.changeFor.replace(
        '{{name}}',
        'Synthetic external contact'
      ),
      exact: true,
    })
    .click()
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.custom,
      exact: true,
    })
    .click()
  await speakers
    .getByLabel(meetings.speakerAttribution.label, { exact: true })
    .fill('Synthetic final label')
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.saveLabel,
      exact: true,
    })
    .click()
  await expect(
    speakers.getByText('Synthetic final label', { exact: true })
  ).toBeVisible()
  await expect
    .poll(async () =>
      (
        await (await api(recordPath + 'original-segments/')).json()
      ).results.every((row) => row.speaker_label === 'Synthetic final label')
    )
    .toBe(true)
  await expect(
    page.getByTestId('transcript').getByText(/^Synthetic final label:/)
  ).toHaveCount(3)
  // A real concurrent edit makes this opened picker stale. The UI must block retry.
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.changeFor.replace(
        '{{name}}',
        'Synthetic final label'
      ),
      exact: true,
    })
    .click()
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.custom,
      exact: true,
    })
    .click()
  const current = await (await api(recordPath)).json()
  expect(
    (
      await api(decisionPath, {
        action: 'set_label',
        label: 'Synthetic concurrent label',
        expected_revision: current.revision,
      })
    ).status()
  ).toBe(200)
  await speakers
    .getByLabel(meetings.speakerAttribution.label, { exact: true })
    .fill('Synthetic stale label')
  const conflictResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.endsWith('/identity-decision/')
  )
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.saveLabel,
      exact: true,
    })
    .click()
  expect((await conflictResponse).status()).toBe(409)
  await expect(speakers.getByRole('alert')).toHaveText(
    meetings.speakerAttribution.changed,
    { timeout: 15000 }
  )
  await expect(
    speakers.getByRole('button', {
      name: meetings.speakerAttribution.saveLabel,
      exact: true,
    })
  ).toBeDisabled()
  await page.screenshot({
    path: join(config.artifacts, 'conflict-desktop.png'),
    fullPage: true,
  })
  await speakers.getByRole('button', { name: /实际是谁$/ }).click()
  // Refetch the current revision before reopening; the rejected operation remains unapplied.
  await expect
    .poll(
      async () =>
        (await (await api(recordPath + 'speakers/')).json()).results[0]
          .display_name
    )
    .toBe('Synthetic concurrent label')
  await expect(
    speakers.getByText('Synthetic concurrent label', { exact: true })
  ).toBeVisible({ timeout: 15000 })
  await speakers.getByRole('button', { name: /实际是谁$/ }).click()
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.custom,
      exact: true,
    })
    .click()
  await speakers
    .getByLabel(meetings.speakerAttribution.label, { exact: true })
    .fill('Synthetic final label')
  await speakers
    .getByRole('button', {
      name: meetings.speakerAttribution.saveLabel,
      exact: true,
    })
    .click()
  await expect(
    speakers.getByText('Synthetic final label', { exact: true })
  ).toBeVisible()
  const deniedContext = await browser.newContext()
  await deniedContext.addCookies(cookies(config.users[1]))
  const denied = await deniedContext.request.get(
    base + '/api/v1.0/' + recordPath
  )
  expect([403, 404]).toContain(denied.status())
  await deniedContext.close()
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['light', 390],
    ['dark', 390],
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }, theme)
    const measurement = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(measurement.document).toBeLessThanOrEqual(width + 1)
    measurements.push({ theme, ...measurement })
    await page.screenshot({
      path: join(config.artifacts, `final-${theme}-${width}.png`),
      fullPage: true,
    })
  }
  expect(errors).toEqual([])
  expect(blocked).toBe(0)
  expect(uploadCount).toBe(1)
  await writeFile(
    join(config.artifacts, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'passed',
        real_api: true,
        uploads: uploadCount,
        suggestion_confirmed: true,
        contact_selected: true,
        custom_label_saved: true,
        duplicate_confirmation: 409,
        concurrent_edit: 409,
        stale_retry_disabled: true,
        denied_read: denied.status(),
        measurements,
        page_errors: errors,
        blocked_external: blocked,
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({ status: 'passed', real_public_upload_web_review: true })
  )
} catch (error) {
  if (page)
    await page
      .screenshot({
        path: join(config.artifacts, 'failure.png'),
        fullPage: true,
      })
      .catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  await browser?.close()
  await vite.close()
  agent.destroy()
}
