/** Isolated real-browser contract review. Uses only fake microphone audio. */
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
  PROFILE = '33333333-3333-4333-8333-333333333333',
  ENROLL = '44444444-4444-4444-8444-444444444444',
  SAMPLE = '55555555-5555-4555-8555-555555555555'
const expiry = new Date(Date.now() + 600000).toISOString()
let slots = [],
  samples = [],
  uploaded,
  permissionWrites = 0,
  registrations = 0
const config = {
  is_silent_login_enabled: false,
  subtitle: { enabled: false },
  telephony: { enabled: false },
  calendar: { enabled: false },
  background_image: { upload_is_enabled: false },
  livekit: { url: '', default_sources: [] },
  feedback: { url: '' },
}
const settings = {
  organization_id: null,
  available: true,
  version: 1,
  generation: 1,
  allow_enrollment: true,
  allow_accumulation: false,
  allow_identification: false,
  profiles: [
    {
      id: PROFILE,
      status: 'pending',
      generation: 1,
      confirmed_at: null,
      last_updated_at: null,
    },
  ],
}
const enrollment = () => ({
  id: ENROLL,
  organization_id: null,
  profile_id: PROFILE,
  status: 'open',
  expires_at: expiry,
  consent_version: 1,
  generation: 1,
  challenges: Array.from({ length: 6 }, (_, i) => `Synthetic prompt ${i + 1}`),
  max_clips: 6,
  uploaded_slots: slots,
  sample_rate: 24000,
  channels: 1,
  format: 'pcm16_wav',
  clip_duration_ms: { minimum: 3000, maximum: 10000 },
  upload_token: 'x'.repeat(43),
})
const api = httpServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5188')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-voiceprint-owner,x-voiceprint-upload-token'
  )
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,PATCH,POST,PUT,DELETE,OPTIONS'
  )
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
  else if (path === 'users/me')
    value = {
      id: OWNER,
      email: '',
      full_name: 'Synthetic Reviewer',
      last_name: '',
      language: 'zh-hans',
      timezone: 'Asia/Shanghai',
    }
  else if (
    path.startsWith('voiceprint/') &&
    req.headers['x-voiceprint-owner'] !== OWNER
  ) {
    status = 401
    value = { code: 'voiceprint_account_changed' }
  } else if (path === 'voiceprint/scopes/')
    value = { results: [], next_offset: null }
  else if (path === 'voiceprint/settings/') {
    if (req.method === 'PATCH') permissionWrites++
    value = settings
  } else if (path === 'voiceprint/samples/')
    value = { results: samples, next_offset: null }
  else if (path === 'voiceprint/deletions/')
    value = { results: [], next_offset: null }
  else if (
    path === 'voiceprint/enrollments/' ||
    path === `voiceprint/enrollments/${ENROLL}/`
  ) {
    if (req.method === 'POST') registrations++
    value = enrollment()
  } else if (
    path === `voiceprint/enrollments/${ENROLL}/clips/0/` &&
    req.method === 'PUT'
  ) {
    const buffers = []
    for await (const chunk of req) buffers.push(chunk)
    const bytes = Buffer.concat(buffers)
    uploaded = {
      bytes: bytes.length,
      length: Number(req.headers['content-length']),
      type: req.headers['content-type'],
      owner: req.headers['x-voiceprint-owner'],
      permit: req.headers['x-voiceprint-upload-token'],
      rate: bytes.readUInt32LE(24),
      channels: bytes.readUInt16LE(22),
      bits: bytes.readUInt16LE(34),
      seconds: bytes.readUInt32LE(40) / 48000,
    }
    slots = [0]
    value = {
      id: SAMPLE,
      profile_id: PROFILE,
      status: 'quality_pending',
      source_type: 'enrollment',
      duration_ms: Math.round(uploaded.seconds * 1000),
      expires_at: expiry,
      confirmable: false,
      audio_available: true,
    }
    samples = [value]
    status = 202
  } else {
    status = 404
    value = { code: 'fixture_route_unavailable' }
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${api.address().port}`
const harness = `import React,{Suspense,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '/src/styles/index.css';import '/src/i18n/init';
import {SettingsDialog} from '/src/features/settings/components/SettingsDialog';
import {setTokens} from '/src/features/auth/utils/tokenStorage';
setTokens({accessToken:'synthetic-fixture'});localStorage.setItem('i18nextLng','zh');
function Review(){const[open,setOpen]=useState(true);return React.createElement(SettingsDialog,{isOpen:open,onOpenChange:setOpen,initialSection:'voiceprint'})}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(Suspense,{fallback:null},React.createElement(Review)))));`
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  plugins: [
    {
      name: 'isolated-voiceprint-review',
      resolveId(id) {
        if (id === 'virtual:voiceprint-review.tsx')
          return '\0virtual:voiceprint-review.tsx'
      },
      load(id) {
        if (id === '\0virtual:voiceprint-review.tsx') return harness
      },
      configureServer(server) {
        server.middlewares.use('/__voiceprint-review/', async (_req, res) => {
          const html = await server.transformIndexHtml(
            '/__voiceprint-review/',
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:voiceprint-review.tsx"></script></body></html>'
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
  blocked = [],
  artifacts =
    process.env.VOICEPRINT_REVIEW_ARTIFACT_DIR ||
    join(tmpdir(), 'we-meet-voiceprint-web-review')
await mkdir(artifacts, { recursive: true })
try {
  await vite.listen()
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    permissions: ['microphone'],
    locale: 'zh-CN',
  })
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    if (['127.0.0.1', 'localhost'].includes(host)) return route.continue()
    blocked.push(host)
    return route.abort()
  })
  await context.addInitScript(() => {
    window.__voiceTracks = []
    window.__decodeStats = []
    const decode = BaseAudioContext.prototype.decodeAudioData
    BaseAudioContext.prototype.decodeAudioData = async function (bytes) {
      try {
        const buffer = await decode.call(this, bytes)
        let peak = 0
        for (let c = 0; c < buffer.numberOfChannels; c++)
          for (const value of buffer.getChannelData(c))
            peak = Math.max(peak, Math.abs(value))
        window.__decodeStats.push({
          rate: buffer.sampleRate,
          frames: buffer.length,
          channels: buffer.numberOfChannels,
          peak,
        })
        return buffer
      } catch (error) {
        window.__decodeStats.push({ error: error.name })
        throw error
      }
    }
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    )
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args)
      window.__voiceTracks.push(...stream.getTracks())
      return stream
    }
  })
  page = await context.newPage()
  page.on('pageerror', (e) => {
    errors.push(e.message)
    console.log('BROWSER ERROR', e.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('CONSOLE ERROR', message.text())
  })
  await page.goto('http://127.0.0.1:5188/__voiceprint-review/')
  await expect(
    page.getByRole('button', { name: '开始登记', exact: true })
  ).toBeVisible({ timeout: 90000 })
  expect(registrations).toBe(0)
  expect(permissionWrites).toBe(0)
  await page.screenshot({ path: `${artifacts}/desktop-light.png` })
  await page.getByRole('button', { name: '开始登记', exact: true }).click()
  await expect(
    page.getByText('Synthetic prompt 1', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: '录音', exact: true }).click()
  await expect(page.getByText(/正在录音：/)).toBeVisible()
  await page.waitForTimeout(4200)
  await page.getByRole('button', { name: '结束录音', exact: true }).click()
  await expect(page.getByLabel('上传前试听')).toBeVisible({ timeout: 15000 })
  expect(
    await page.evaluate(() =>
      window.__voiceTracks.every((t) => t.readyState === 'ended')
    )
  ).toBe(true)
  await page.getByRole('button', { name: '上传本人片段', exact: true }).click()
  await expect(page.getByText('质量待审核', { exact: true })).toBeVisible()
  expect(uploaded.length).toBe(uploaded.bytes)
  expect(uploaded.type).toBe('audio/wav')
  expect(uploaded.rate).toBe(24000)
  expect(uploaded.channels).toBe(1)
  expect(uploaded.bits).toBe(16)
  expect(uploaded.seconds).toBeGreaterThanOrEqual(3)
  expect(uploaded.seconds).toBeLessThanOrEqual(10)
  await expect(
    page.getByRole('button', { name: '确认本人片段', exact: true })
  ).toHaveCount(0)
  await page.getByRole('button', { name: '录音', exact: true }).click()
  await expect(page.getByText(/正在录音：/)).toBeVisible()
  await page.getByRole('button', { name: '取消本段录音', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '录音', exact: true })
  ).toBeEnabled()
  expect(
    await page.evaluate(() =>
      window.__voiceTracks.every((t) => t.readyState === 'ended')
    )
  ).toBe(true)
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark')
  )
  await page.screenshot({ path: `${artifacts}/desktop-dark.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('dialog')
    .locator('section')
    .first()
    .evaluate((el) => (el.scrollTop = 0))
  await page.screenshot({ path: `${artifacts}/mobile-dark.png` })
  const overflow = await page.getByRole('dialog').evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    sections: [...el.querySelectorAll('section')].map((s) => ({
      width: s.clientWidth,
      scroll: s.scrollWidth,
    })),
  }))
  expect(overflow.sections[0].width).toBeGreaterThan(280)
  const selected = await page
    .getByRole('dialog')
    .locator('nav [aria-current="true"]')
    .boundingBox()
  expect(selected.x).toBeGreaterThanOrEqual(16)
  expect(selected.x + selected.width).toBeLessThanOrEqual(374)
  expect(overflow.sections.every((s) => s.scroll <= s.width)).toBe(true)
  await page.evaluate(() => (document.documentElement.style.fontSize = '24px'))
  await page.screenshot({ path: `${artifacts}/mobile-large-dark.png` })
  const large = await page.getByRole('dialog').evaluate((el) =>
    [...el.querySelectorAll('section')].map((s) => ({
      width: s.clientWidth,
      scroll: s.scrollWidth,
    }))
  )
  expect(large.every((s) => s.scroll <= s.width)).toBe(true)
  await page.evaluate(() => (document.documentElement.style.fontSize = ''))
  await page.getByRole('button', { name: '录音', exact: true }).click()
  await expect(page.getByText(/正在录音：/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__voiceTracks.every((t) => t.readyState === 'ended')
      )
    )
    .toBe(true)
  const result = {
    uploaded: { ...uploaded, permit: uploaded.permit ? 'present' : null },
    registrations,
    permissionWrites,
    errors,
    blocked,
    overflow,
    syntheticOnly: true,
    decode: await page.evaluate(() => window.__decodeStats),
  }
  await writeFile(`${artifacts}/result.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
} catch (error) {
  console.log('REVIEW FAILED', error.message)
  if (page) {
    console.log(
      'SYNTHETIC DECODE',
      await page.evaluate(() => window.__decodeStats)
    )
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
