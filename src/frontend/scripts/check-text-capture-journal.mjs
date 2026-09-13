// Real Chromium IndexedDB checks; no microphone, backend or provider calls.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const origin = process.env.CAPTURE_TEST_ORIGIN || 'http://127.0.0.1:3187'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/text-capture-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Text capture storage test</title>',
    })
  )
  await page.goto(`${origin}/text-capture-test`)
  const result = await page.evaluate(async () => {
    const { CaptureJournal } =
      await import('/src/features/meetings/capture/journal.ts')
    const readDisk = (viewer) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(`meeting-audio-v1:${viewer}`, 1)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('chunks', 'readonly')
          const rows = tx.objectStore('chunks').getAll()
          rows.onsuccess = () => resolve(rows.result)
          tx.oncomplete = () => db.close()
        }
      })
    const journal = await CaptureJournal.open('text-memory')
    const capture = await journal.create('Temporary audio', 'text')
    const chunk = await journal.append(
      capture.id,
      new Int16Array(16000).fill(4096)
    )
    const onDisk = await readDisk('text-memory')
    const inMemory = (await journal.chunks(capture.id))[0]
    const diskHasNoAudio = onDisk.length === 1 && onDisk[0].audio === undefined
    const memoryHasAudio = inMemory.audio.byteLength === 32044
    journal.close()
    const memoryZeroed = new Uint8Array(inMemory.audio).every(
      (byte) => byte === 0
    )
    const recovered = await CaptureJournal.open('text-memory')
    const after = (await recovered.list())[0]
    const absentAfterReopen =
      (await recovered.chunks(capture.id))[0].audio === undefined
    const gapRetained =
      after.nextSequence === 2 &&
      after.pendingBytes === 0 &&
      after.interrupted &&
      after.closed
    // A lost upload response can still match the persisted checksum/timing receipt.
    await recovered.acknowledge(capture.id, {
      ...chunk,
      audio: undefined,
      id: crypto.randomUUID(),
      stored: true,
    })
    const receiptPreserved = (await recovered.chunks(capture.id))[0].receipt
      .stored
    recovered.close()

    const ackJournal = await CaptureJournal.open('text-ack')
    const ackCapture = await ackJournal.create('Ack deletion', 'text')
    const ackChunk = await ackJournal.append(
      ackCapture.id,
      new Int16Array(16000).fill(2048)
    )
    await ackJournal.acknowledge(ackCapture.id, {
      ...ackChunk,
      audio: undefined,
      id: crypto.randomUUID(),
      stored: true,
    })
    const ackClearsMemory =
      new Uint8Array(ackChunk.audio).every((byte) => byte === 0) &&
      (await ackJournal.list())[0].pendingBytes === 0 &&
      !(await ackJournal.chunks(ackCapture.id))[0].audio
    const tail = await ackJournal.append(
      ackCapture.id,
      new Int16Array(16000).fill(1024)
    )
    await ackJournal.update(ackCapture.id, (row) => ({
      ...row,
      createdAt: '2000-01-01T00:00:00Z',
    }))
    const expiredAudio = await ackJournal.chunks(ackCapture.id)
    const expiryClearsMemory =
      expiredAudio.every((row) => !row.audio) &&
      new Uint8Array(tail.audio).every((byte) => byte === 0)
    let expiredAppendRejected = false
    try {
      await ackJournal.append(ackCapture.id, new Int16Array(16000))
    } catch {
      expiredAppendRejected = true
    }
    ackJournal.close()
    return {
      diskHasNoAudio,
      memoryHasAudio,
      memoryZeroed,
      absentAfterReopen,
      gapRetained,
      receiptPreserved,
      ackClearsMemory,
      expiryClearsMemory,
      expiredAppendRejected,
    }
  })
  assert.deepEqual(
    result,
    Object.fromEntries(Object.keys(result).map((key) => [key, true]))
  )
  console.log(
    'Text-audio journal checks passed:',
    Object.keys(result).join(', ')
  )
} finally {
  await browser.close()
}
