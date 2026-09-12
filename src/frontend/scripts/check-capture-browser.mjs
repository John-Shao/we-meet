// Run against a local Vite server. Uses synthetic browser audio and native IndexedDB/Web Locks.
// No backend, provider, account credentials or real microphone is used.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
try {
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.route('**/capture-test-harness', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Capture test</title><button>Start</button>',
  }))
  const page = await context.newPage()
  await page.goto(`${origin}/capture-test-harness`)
  const result = await page.evaluate(async () => {
    const { CaptureJournal } = await import('/src/features/meetings/capture/journal.ts')
    const { MAX_PENDING_BYTES } = await import('/src/features/meetings/capture/pcm.ts')
    const journal = await CaptureJournal.open('test-viewer-a')
    const session = await journal.create('Native persistence')
    const pcm = new Int16Array(16000).fill(512)
    const chunk = await journal.append(session.id, pcm)
    const reject = async (run) => { try { await run(); return false } catch { return true } }
    const duplicateCaptureRejected = await reject(() => journal.create('Second active capture'))
    const badAckRejected = await reject(() => journal.acknowledge(session.id, {
      ...chunk, id: crypto.randomUUID(), stored: true, checksum: '0'.repeat(64),
    }))
    journal.close()
    const recovered = await CaptureJournal.open('test-viewer-a')
    const persisted = (await recovered.chunks(session.id))[0]
    const ack = { ...persisted, id: crypto.randomUUID(), stored: true }
    delete ack.audio
    await recovered.acknowledge(session.id, ack)
    await recovered.acknowledge(session.id, ack)
    const acknowledged = (await recovered.chunks(session.id))[0]
    const zeroPending = (await recovered.list())[0].pendingBytes === 0
    await recovered.update(session.id, (current) => ({ ...current, pendingBytes: MAX_PENDING_BYTES }))
    const quotaRejected = await reject(() => recovered.append(session.id, pcm))
    const sequenceAfterFailure = (await recovered.list())[0].nextSequence
    await recovered.update(session.id, (current) => ({ ...current, pendingBytes: 0, closed: true }))
    const closedRejected = await reject(() => recovered.append(session.id, pcm))
    const other = await CaptureJournal.open('test-viewer-b')
    const isolated = (await other.list()).length === 0
    other.close()
    recovered.close()
    return { duplicateCaptureRejected, badAckRejected, zeroPending, quotaRejected, closedRejected, isolated,
      sequenceAfterFailure, persistedBytes: persisted.audio.byteLength,
      releasedBytes: acknowledged.audio === undefined, retainedReceipt: acknowledged.receipt.id === ack.id }
  })
  assert.deepEqual(result, {
    duplicateCaptureRejected: true, badAckRejected: true, zeroPending: true, quotaRejected: true,
    closedRejected: true, isolated: true, sequenceAfterFailure: 2, persistedBytes: 32044,
    releasedBytes: true, retainedReceipt: true,
  })

  await page.evaluate(async () => {
    const { withCaptureLock } = await import('/src/features/meetings/capture/microphone.ts')
    window.lockTask = withCaptureLock('lock-viewer', () => new Promise((resolve) => {
      window.releaseCaptureLock = resolve
      window.captureLockAcquired = true
    }))
  })
  await page.waitForFunction(() => window.captureLockAcquired)
  const otherTab = await context.newPage()
  await otherTab.goto(`${origin}/capture-test-harness`)
  const lockRejected = await otherTab.evaluate(async () => {
    const { withCaptureLock } = await import('/src/features/meetings/capture/microphone.ts')
    try { await withCaptureLock('lock-viewer', async () => true); return false } catch { return true }
  })
  assert.equal(lockRejected, true)
  await page.evaluate(async () => { window.releaseCaptureLock(); await window.lockTask })

  await page.evaluate(async () => {
    const { CaptureMicrophone } = await import('/src/features/meetings/capture/microphone.ts')
    const { CaptureJournal } = await import('/src/features/meetings/capture/journal.ts')
    const journal = await CaptureJournal.open('synthetic-audio-viewer')
    const session = await journal.create('Synthetic audio')
    window.captureChunks = 0
    window.captureFailed = false
    document.querySelector('button').onclick = async () => {
      window.captureMic = await CaptureMicrophone.open(async (pcm) => {
        await journal.append(session.id, pcm)
        window.captureChunks++
      }, () => { window.captureFailed = true })
      window.captureMic.start()
      window.captureRead = async () => ({ chunks: await journal.chunks(session.id), session: (await journal.list())[0] })
    }
  })
  await page.getByRole('button').click()
  await page.waitForFunction(() => window.captureChunks >= 1 || window.captureFailed, null, { timeout: 15000 })
  const audio = await page.evaluate(async () => {
    await window.captureMic.stop()
    const result = await window.captureRead()
    return { failed: window.captureFailed, count: result.chunks.length,
      duration: result.session.durationMs,
      rate: new DataView(result.chunks[0].audio).getUint32(24, true) }
  })
  assert.equal(audio.failed, false)
  assert.ok(audio.count >= 1 && audio.duration >= 5000)
  assert.equal(audio.rate, 16000)
  console.log('Native capture checks passed: journal atomicity/recovery, account isolation, tab lock, AudioWorklet PCM.')
} finally {
  await browser.close()
}
