/** Real browser upload/recovery against local synthetic contracts; no microphone. */
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const OWNER = '11111111-1111-4111-8111-111111111111'
const RECORD = '22222222-2222-4222-8222-222222222222'
const ORG = '44444444-4444-4444-8444-444444444444'
const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts =
  process.env.VOICEPRINT_REVIEW_ARTIFACT_DIR ??
  join(tmpdir(), 'we-meet-import-identity-review')
await mkdir(artifacts, { recursive: true })
process.env.VITE_API_BASE_URL = 'http://127.0.0.1:5198'
let candidateName = '合成测试本人'
let state,
  uploads = 0,
  decisions = 0
const requests = [],
  errors = [],
  blocked = [],
  measurements = []
const harness = `import React,{Suspense,useState}from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import'/src/styles/index.css';import'/src/i18n/init';import{RecordingUpload,UploadedRecordingStatus}from'/src/features/meetings/components/RecordingUpload';import{setTokens}from'/src/features/auth/utils/tokenStorage';localStorage.setItem('i18nextLng','zh');setTokens({accessToken:'synthetic-fixture'});function Fixture(){const[record,setRecord]=useState(null);return record?React.createElement(UploadedRecordingStatus,{recordId:record,viewerId:'${OWNER}'}):React.createElement(RecordingUpload,{viewerId:'${OWNER}',onRecord:setRecord})}createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(Suspense,{fallback:null},React.createElement(Fixture)))));`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
  plugins: [
    {
      name: 'import-identity-review',
      resolveId(id) {
        if (id === 'virtual:import-identity-review.tsx')
          return '\0virtual:import-identity-review.tsx'
      },
      load(id) {
        if (id === '\0virtual:import-identity-review.tsx') return harness
      },
      configureServer(server) {
        server.middlewares.use('/__import-review/', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/__import-review/',
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:import-identity-review.tsx"></script></body></html>'
          )
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        })
      },
    },
  ],
})
let browser
try {
  await vite.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) => {
    if (
      ['localhost', '127.0.0.1'].includes(
        new URL(route.request().url()).hostname
      )
    )
      return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  await context.routeWebSocket('**', (socket) => socket.close())
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('No human media permitted')
    }
  })
  await context.route('**/api/v1.0/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace('/api/v1.0/', '')
    requests.push({ path, method: request.method() })
    let value
    if (path === 'recording-uploads/' && request.method() === 'GET')
      value = {
        available: true,
        extensions: ['wav'],
        max_bytes: 1024 * 1024,
        identity_preflight: {
          available: true,
          max_candidates: 50,
          max_bytes: 512 * 1024 * 1024,
        },
      }
    else if (path.startsWith('voiceprint/scopes/'))
      value = {
        results: [
          {
            id: ORG,
            name: '合成测试组织',
            policy: { enabled: true, version: 1 },
            can_manage_policy: false,
          },
        ],
        next_offset: null,
      }
    else if (path.startsWith('recording-uploads/identity-candidates/')) {
      expect(request.headers()['x-voiceprint-owner']).toBe(OWNER)
      value = {
        organization_id:
          url.searchParams.get('organization_id') === 'personal' ? null : ORG,
        results: [{ id: OWNER, name: candidateName }],
        next_offset: null,
      }
    } else if (path === 'recording-uploads/' && request.method() === 'POST') {
      expect(request.headers()['x-voiceprint-owner']).toBe(OWNER)
      const body = request.postDataBuffer()
      expect(body.includes(Buffer.from(OWNER))).toBe(true)
      expect(body.includes(Buffer.from('candidate_user_ids'))).toBe(true)
      uploads++
      state = {
        record_id: RECORD,
        status: 'failed',
        attempt: 1,
        retryable: false,
        error_code: 'identity_preflight_failed',
        identity_preflight: {
          status: 'awaiting_choice',
          reason: 'media_probe_invalid',
          can_continue_without_identity: true,
        },
      }
      value = state
    } else if (path === `recording-uploads/${RECORD}/identity-preflight/`) {
      expect(request.headers()['x-voiceprint-owner']).toBe(OWNER)
      expect(request.postDataJSON()).toEqual({
        expected_attempt: 1,
        action: 'continue_without_identity',
      })
      decisions++
      state = {
        record_id: RECORD,
        status: 'queued',
        attempt: 2,
        retryable: false,
        error_code: '',
        identity_preflight: {
          status: 'disabled',
          reason: '',
          can_continue_without_identity: false,
        },
      }
      value = state
    } else if (path === `recording-uploads/${RECORD}/`) value = state
    else throw new Error('Unexpected local request: ' + path)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store' },
      body: JSON.stringify(value),
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5198/__import-review/')
  const file = Buffer.alloc(44 + 4800)
  file.write('RIFF')
  file.writeUInt32LE(file.length - 8, 4)
  file.write('WAVEfmt ', 8)
  file.writeUInt32LE(16, 16)
  file.writeUInt16LE(1, 20)
  file.writeUInt16LE(1, 22)
  file.writeUInt32LE(24000, 24)
  file.writeUInt32LE(48000, 28)
  file.writeUInt16LE(2, 32)
  file.writeUInt16LE(16, 34)
  file.write('data', 36)
  file.writeUInt32LE(4800, 40)
  await expect(
    page.getByRole('button', { name: '导入', exact: true })
  ).toBeVisible({ timeout: 90000 })
  await page.locator('input[type=file]').setInputFiles({
    name: '合成媒体.wav',
    mimeType: 'audio/wav',
    buffer: file,
  })
  await page.getByText('识别说话人身份', { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: '识别说话人身份', exact: true })
  ).toBeChecked()
  await page.getByText('合成测试本人', { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: '合成测试本人', exact: true })
  ).toBeChecked()
  await expect(
    page.getByRole('button', { name: '导入并转写', exact: true })
  ).toBeEnabled()
  for (const [name, width, font, theme] of [
    ['desktop-light', 1280, '', 'light'],
    ['desktop-dark', 1280, '', 'dark'],
    ['mobile-light', 390, '', 'light'],
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
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({
      path: join(artifacts, name + '.png'),
      animations: 'disabled',
    })
    const size = await page.getByRole('dialog').evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      docWidth: document.documentElement.clientWidth,
      docScroll: document.documentElement.scrollWidth,
      formWidth: element.querySelector('form').clientWidth,
      formScroll: element.querySelector('form').scrollWidth,
    }))
    measurements.push({ name, ...size })
    expect(size.scroll).toBeLessThanOrEqual(size.width + 1)
    expect(size.docScroll).toBeLessThanOrEqual(size.docWidth + 1)
    expect(size.formScroll).toBeLessThanOrEqual(size.formWidth + 1)
  }
  candidateName = 'SyntheticMemberWithoutSpaces'.repeat(12)
  await page
    .getByRole('textbox', { name: '搜索成员', exact: true })
    .fill('long')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText(candidateName, { exact: true })).toBeVisible()
  await page.getByText(candidateName, { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: candidateName, exact: true })
  ).not.toBeChecked()
  await page.getByText(candidateName, { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: candidateName, exact: true })
  ).toBeChecked()
  await expect(
    page.getByRole('button', { name: '导入并转写', exact: true })
  ).toBeEnabled()
  const longNameSize = await page
    .getByRole('dialog')
    .locator('form')
    .evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }))
  expect(longNameSize.scroll).toBeLessThanOrEqual(longNameSize.width + 1)
  await page.screenshot({
    path: join(artifacts, 'mobile-long-name.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '导入并转写', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '继续普通转写', exact: true })
  ).toBeVisible()
  expect(uploads).toBe(1)
  expect(decisions).toBe(0)
  await page.screenshot({ path: join(artifacts, 'preflight-choice.png') })
  await page.getByRole('button', { name: '继续普通转写', exact: true }).click()
  await expect(page.getByText('等待转写', { exact: true })).toBeVisible()
  expect(uploads).toBe(1)
  expect(decisions).toBe(1)
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      { uploads, decisions, errors, blocked, measurements, requests },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      uploads,
      decisions,
      screenshots: 6,
      errors,
      blocked,
      artifacts,
    })
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  await vite.close()
}
