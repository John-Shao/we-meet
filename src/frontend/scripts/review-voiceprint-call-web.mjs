/** Browser review with synthetic RTC metadata and HTTP only; no media access. */
import process from 'node:process'
import { createServer as httpServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const zh = JSON.parse(
  await readFile(join(root, 'src/locales/zh/voiceprint.json'), 'utf8')
)
const globalZh = JSON.parse(
  await readFile(join(root, 'src/locales/zh/global.json'), 'utf8')
)
const OWNER = '11111111-1111-4111-8111-111111111111'
const SESSION = '77777777-7777-4777-8777-777777777777'
const ROOM = 'RM_synthetic',
  PARTICIPANT = 'PA_synthetic'
const writes = [],
  blocked = [],
  errors = []
let unavailable = false,
  control = {
    session_id: SESSION,
    participant_sid: PARTICIPANT,
    revision: 0,
    paused: true,
    shared_microphone: true,
    device_group: '',
    state: 'paused',
    stop_reason: '',
    runtime: { state: 'stopped', reason: 'paused', updated_at: null },
  }
const permission = {
  available: true,
  version: 3,
  allow_enrollment: true,
  allow_accumulation: true,
}
const config = {
  is_silent_login_enabled: false,
  subtitle: { enabled: false },
  telephony: { enabled: false },
  calendar: { enabled: false },
  background_image: { upload_is_enabled: false },
  livekit: { url: '', default_sources: [] },
  feedback: { url: '' },
}
const api = httpServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5189')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,OPTIONS')
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://fixture'),
    path = url.pathname.replace('/api/v1.0/', '')
  let value,
    status = 200
  if (path === 'config/') value = config
  else if (
    path.startsWith('voiceprint/') &&
    req.headers['x-voiceprint-owner'] !== OWNER
  ) {
    status = 401
    value = { code: 'voiceprint_owner_changed' }
  } else if (path === 'voiceprint/sampling-connection/') {
    if (unavailable) {
      status = 503
      value = { code: 'private fixture detail' }
    } else if (
      url.searchParams.get('room_sid') !== ROOM ||
      url.searchParams.get('participant_sid') !== PARTICIPANT
    ) {
      status = 404
      value = { code: 'fixture_connection_missing' }
    } else
      value = {
        room_sid: ROOM,
        organization_id: null,
        organization_name: null,
        observed_at: new Date().toISOString(),
        permission,
        control,
        limits: {
          clip_ms: 10000,
          session_ms: 60000,
          daily_ms: 120000,
          candidate_retention_seconds: 86400,
        },
      }
  } else if (
    path === 'voiceprint/sampling-control/' &&
    req.method === 'PATCH'
  ) {
    let body = ''
    for await (const chunk of req) body += chunk
    const changes = JSON.parse(body)
    writes.push({ path, changes })
    if (changes.expected_revision !== control.revision) {
      status = 409
      value = { code: 'fixture_conflict' }
    } else {
      control = {
        ...control,
        paused: changes.paused,
        shared_microphone: changes.shared_microphone,
        device_group: changes.device_group,
        revision: control.revision + 1,
        state: changes.paused ? 'paused' : 'ready',
        runtime: {
          state: changes.paused ? 'stopped' : 'waiting',
          reason: '',
          updated_at: null,
        },
      }
      value = control
    }
  } else if (path === 'voiceprint/settings/' && req.method === 'PATCH') {
    let body = ''
    for await (const chunk of req) body += chunk
    const changes = JSON.parse(body)
    writes.push({ path, changes })
    permission.allow_accumulation = false
    permission.version++
    control.state = 'authorization_required'
    control.runtime = {
      state: 'stopped',
      reason: 'authorization_required',
      updated_at: null,
    }
    value = {
      organization_id: null,
      ...permission,
      generation: 1,
      allow_identification: false,
      profiles: [],
    }
  } else {
    status = 404
    value = { code: 'fixture_route_unavailable' }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${api.address().port}`
const harness = `import React,{Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '/src/styles/index.css';import '/src/i18n/init';
import {VoiceprintCallPanel} from '/src/features/voiceprint/VoiceprintCallControl';
import {CallSamplingClient} from '/src/features/voiceprint/callSamplingApi';
import {CallSamplingController} from '/src/features/voiceprint/callSamplingController';
import {setTokens} from '/src/features/auth/utils/tokenStorage';
setTokens({accessToken:'synthetic-fixture'});
const controller=new CallSamplingController(new CallSamplingClient('${OWNER}','${ROOM}','${PARTICIPANT}'));
window.__callReviewController=controller;
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
  React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},
    React.createElement(Suspense,{fallback:null},
      React.createElement('div',{style:{position:'relative',height:'100dvh',background:'#182339',color:'white'}},
        React.createElement('p',{style:{position:'absolute',top:'45%',left:'20%'}},'Synthetic call stage — no RTC or media'),
        React.createElement(VoiceprintCallPanel,{controller,microphoneEnabled:true})
      )
    )
  )
));`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 5189, strictPort: true, hmr: false },
  plugins: [
    {
      name: 'isolated-call-voiceprint-review',
      resolveId(id) {
        if (id === 'virtual:voiceprint-call-review.tsx')
          return '\0virtual:voiceprint-call-review.tsx'
      },
      load(id) {
        if (id === '\0virtual:voiceprint-call-review.tsx') return harness
      },
      configureServer(server) {
        server.middlewares.use(
          '/__voiceprint-call-review/',
          async (_req, res) => {
            const html = await server.transformIndexHtml(
              '/__voiceprint-call-review/',
              '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:voiceprint-call-review.tsx"></script></body></html>'
            )
            res.setHeader('Content-Type', 'text/html')
            res.end(html)
          }
        )
      },
    },
  ],
})
const artifacts =
  process.env.VOICEPRINT_REVIEW_ARTIFACT_DIR ||
  join(tmpdir(), 'we-meet-voiceprint-call-review')
await mkdir(artifacts, { recursive: true })
let browser, page
try {
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    if (['127.0.0.1', 'localhost'].includes(host)) return route.continue()
    blocked.push(host)
    return route.abort()
  })
  await context.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'zh')
    window.__mediaCalls = []
    for (const name of ['getUserMedia', 'getDisplayMedia']) {
      navigator.mediaDevices[name] = async () => {
        window.__mediaCalls.push(name)
        throw new Error('Media forbidden in synthetic review')
      }
    }
  })
  page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:5189/__voiceprint-call-review/')
  await page
    .getByRole('button', { name: zh.call.open })
    .click({ timeout: 90000 })
  await expect(page.getByRole('switch', { name: zh.call.shared })).toBeChecked()
  await expect(
    page.getByRole('button', { name: zh.call.resume })
  ).toBeDisabled()
  expect(writes).toHaveLength(0)
  await page.screenshot({
    path: join(artifacts, 'desktop-light.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: new RegExp(zh.call.device) }).click()
  await page.getByRole('option', { name: zh.deviceGroup.headset }).click()
  expect(writes).toHaveLength(0)
  await page.getByRole('button', { name: zh.call.saveDevice }).click()
  await expect(page.getByRole('switch', { name: zh.call.shared })).toBeEnabled()
  expect(writes[0].changes).toMatchObject({
    paused: true,
    shared_microphone: true,
    device_group: 'headset',
  })
  await page.getByRole('switch', { name: zh.call.shared }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: zh.call.resume })).toBeEnabled()
  await page.getByRole('button', { name: zh.call.resume }).click()
  await expect(page.getByRole('status')).toContainText(zh.call.phase.waiting)
  control.runtime = {
    state: 'sampling',
    reason: '',
    updated_at: new Date().toISOString(),
  }
  await page.evaluate(() => window.__callReviewController.refresh())
  await expect(page.getByRole('status')).toContainText(zh.call.phase.sampling)
  // Prevent a new heartbeat while checking that a stale positive state expires.
  control.runtime = { state: 'waiting', reason: '', updated_at: null }
  await expect(page.getByRole('status')).toContainText(zh.call.phase.waiting, {
    timeout: 7000,
  })
  await page.getByRole('button', { name: zh.call.pause }).click()
  await expect(page.getByRole('status')).toContainText(zh.call.phase.stopped)
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark')
  )
  await page.screenshot({
    path: join(artifacts, 'desktop-dark.png'),
    animations: 'disabled',
  })
  const layouts = []
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.screenshot({
      path: join(artifacts, `mobile-${width}.png`),
      animations: 'disabled',
    })
    const layout = await page.getByRole('status').evaluate((el) => {
      const panel = el.parentElement,
        rect = panel.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        overflowX: panel.scrollWidth - panel.clientWidth,
        height: rect.height,
        scrollHeight: panel.scrollHeight,
      }
    })
    expect(layout.left).toBeGreaterThanOrEqual(0)
    expect(layout.right).toBeLessThanOrEqual(width)
    expect(layout.overflowX).toBeLessThanOrEqual(1)
    await page
      .getByRole('button', { name: zh.call.settings })
      .scrollIntoViewIfNeeded()
    await expect(
      page.getByRole('button', { name: zh.call.settings })
    ).toBeInViewport()
    layouts.push({ width, ...layout })
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = '24px'))
  await page
    .getByRole('heading', { name: zh.call.title })
    .scrollIntoViewIfNeeded()
  const largeLayout = await page.getByRole('status').evaluate((el) => {
    const panel = el.parentElement,
      rect = panel.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      overflowX: panel.scrollWidth - panel.clientWidth,
    }
  })
  expect(largeLayout.left).toBeGreaterThanOrEqual(0)
  expect(largeLayout.right).toBeLessThanOrEqual(320)
  expect(largeLayout.top).toBeGreaterThanOrEqual(0)
  expect(largeLayout.bottom).toBeLessThanOrEqual(844)
  expect(largeLayout.overflowX).toBeLessThanOrEqual(1)
  await expect(
    page.getByRole('button', { name: globalZh.closeDialog })
  ).toBeInViewport()
  await page.screenshot({
    path: join(artifacts, 'mobile-large-font.png'),
    animations: 'disabled',
  })
  await page
    .getByRole('button', { name: zh.call.settings })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('button', { name: zh.call.settings })
  ).toBeInViewport()
  await page.screenshot({
    path: join(artifacts, 'mobile-large-font-actions.png'),
    animations: 'disabled',
  })
  unavailable = true
  await page.evaluate(() => window.__callReviewController.refresh())
  await expect(page.getByRole('alert')).toHaveText(zh.call.error.unavailable)
  expect(await page.getByRole('dialog').innerText()).not.toContain(
    'private fixture detail'
  )
  unavailable = false
  await page.getByRole('button', { name: zh.reload }).click()
  await expect(page.getByRole('switch', { name: zh.call.shared })).toBeVisible()
  await page
    .getByRole('button', {
      name: zh.call.disableAccumulation.replace('{{scope}}', zh.personal),
    })
    .click()
  await expect(
    page.getByRole('button', { name: zh.call.resume })
  ).toBeDisabled()
  expect(writes.at(-1).changes).toEqual({
    organization_id: null,
    expected_version: 3,
    allow_accumulation: false,
  })
  const mediaCalls = await page.evaluate(() => window.__mediaCalls)
  expect(mediaCalls).toEqual([])
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: zh.call.open })).toBeFocused()
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        mode: 'synthetic RTC metadata and HTTP; no media',
        writes,
        layouts,
        largeLayout,
        mediaCalls,
        errors,
        blocked,
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      passed: true,
      artifacts,
      writes: writes.length,
      mediaCalls: 0,
      layouts,
      largeLayout,
    })
  )
} catch (error) {
  process.exitCode = 1
  await page?.screenshot({ path: join(artifacts, 'failure.png') })
  console.error(
    JSON.stringify({
      failed: true,
      error: String(error),
      errors,
      blocked,
      html: await page?.locator('body').innerText(),
    })
  )
} finally {
  await browser?.close()
  await vite.close()
  await new Promise((resolve) => api.close(resolve))
}
