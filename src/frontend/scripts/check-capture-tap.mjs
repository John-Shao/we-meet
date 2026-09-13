// Real Chromium AudioWorklet/transfer semantics with fake device audio only.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
try {
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.route('**/capture-tap-harness', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PCM tap test</title><button>Start synthetic capture</button>' }))
  const page = await context.newPage()
  await page.goto(`${origin}/capture-tap-harness`)
  await page.evaluate(async () => {
    const { CaptureMicrophone } = await import('/src/features/meetings/capture/microphone.ts')
    const originalOpen = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.deviceOpens = 0
    navigator.mediaDevices.getUserMedia = (...args) => { window.deviceOpens++; return originalOpen(...args) }
    window.originals = []
    window.first = []
    window.firstEnds = []
    window.second = []
    window.secondEnds = []
    window.third = []
    window.thirdEnds = []
    window.failed = false
    document.querySelector('button').onclick = async () => {
      window.mic = await CaptureMicrophone.open(async (pcm) => { window.originals.push(pcm.slice()) }, () => { window.failed = true })
      window.oldDetach = window.mic.observePcm({
        pcm: (samples) => { window.first.push(samples); return window.first.length < 2 },
        ended: (reason) => window.firstEnds.push(reason),
      })
      window.mic.start()
    }
  })
  await page.getByRole('button').click()
  await page.waitForFunction(() => window.firstEnds.length > 0 || window.failed, null, { timeout: 10000 })
  const early = await page.evaluate(() => ({ failed: window.failed, originals: window.originals.length,
    frames: window.first.map((frame) => frame.length), zeroed: window.first.every((frame) => frame.every((v) => v === 0)), ended: window.firstEnds }))
  assert.deepEqual(early, { failed: false, originals: 0, frames: [1600, 1600], zeroed: true, ended: ['backpressure'] })
  await page.waitForFunction(() => window.originals.length > 0 || window.failed, null, { timeout: 10000 })
  await page.evaluate(() => {
    window.newDetach = window.mic.observePcm({
      pcm: (samples) => { window.second.push(samples.slice()); return true },
      ended: (reason) => window.secondEnds.push(reason),
    })
    window.oldDetach()
  })
  await page.waitForFunction(() => window.second.length >= 2 || window.failed, null, { timeout: 10000 })
  const originalsBeforeFinish = await page.evaluate(() => {
    window.newDetach.finish()
    window.newDetach.finish()
    return window.originals.length
  })
  await page.waitForFunction(() => window.secondEnds.length > 0 || window.failed, null, { timeout: 10000 })
  assert.deepEqual(await page.evaluate(() => window.secondEnds), ['finished'])
  await page.waitForFunction((count) => window.originals.length > count || window.failed, originalsBeforeFinish, { timeout: 10000 })
  await page.evaluate(() => {
    window.thirdDetach = window.mic.observePcm({
      pcm: (samples) => { window.third.push(samples.slice()); return true },
      ended: (reason) => window.thirdEnds.push(reason),
    })
    window.newDetach.finish()
    window.newDetach()
  })
  await page.waitForFunction(() => window.third.length >= 2 || window.failed, null, { timeout: 10000 })
  const final = await page.evaluate(async () => {
    await window.mic.stop()
    window.newDetach()
    return { failed: window.failed, deviceOpens: window.deviceOpens, originalFrames: window.originals.reduce((n, pcm) => n + pcm.length, 0),
      firstEnds: window.firstEnds, secondEnds: window.secondEnds, thirdEnds: window.thirdEnds, secondLengths: window.second.map((frame) => frame.length) }
  })
  assert.equal(final.failed, false)
  assert.equal(final.deviceOpens, 1)
  assert.ok(final.originalFrames >= 80000)
  assert.deepEqual(final.firstEnds, ['backpressure'])
  assert.deepEqual(final.secondEnds, ['finished'])
  assert.deepEqual(final.thirdEnds, ['paused'])
  assert.ok(final.secondLengths.every((count) => count >= 16 && count <= 1600 && count % 16 === 0))
  console.log('PCM tap browser checks passed: one microphone, sub-chunk delivery, bounded failure, erased buffers, generation replacement, turn drain without stopping recording, and pause tail.')
} finally { await browser.close() }
