import type {
  ApiCaptureSession,
  CaptureCommandRequest,
  CreateCaptureRequest,
} from '../api/ApiCaptureSession'
import {
  checksum,
  MAX_CHUNKS,
  MAX_PENDING_BYTES,
  pcmWave,
  SAMPLE_RATE,
} from './pcm'

export interface AudioReceipt {
  id: string
  sequence: number
  start_ms: number
  duration_ms: number
  checksum: string
  byte_size: number
  stored: boolean
}

export interface LocalCapture {
  id: string
  createdAt: string
  createKey: string
  create: CreateCaptureRequest
  remote?: ApiCaptureSession
  command?: { key: string; body: CaptureCommandRequest }
  nextSequence: number
  durationMs: number
  pendingBytes: number
  closed: boolean
  sealed: boolean
  interrupted?: boolean
  sealIntent?: { final_sequence: number; client_interrupted: boolean }
}

export interface LocalAudioChunk {
  captureId: string
  sequence: number
  start_ms: number
  duration_ms: number
  checksum: string
  byte_size: number
  audio?: ArrayBuffer
  receipt?: AudioReceipt
}

/** One account per database. Leases and audio never enter URLs, analytics or localStorage. */
export class CaptureJournal {
  private constructor(private db: IDBDatabase) {}

  static async open(viewerId: string): Promise<CaptureJournal> {
    if (!viewerId) throw new Error('missing_viewer')
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`meeting-audio-v1:${viewerId}`, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('sessions', { keyPath: 'id' })
        db.createObjectStore('chunks', { keyPath: ['captureId', 'sequence'] })
      }
      request.onerror = () => reject(new Error('local_storage_unavailable'))
      request.onblocked = () => reject(new Error('local_storage_blocked'))
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(new CaptureJournal(request.result))
      }
    })
  }

  close() {
    this.db.close()
  }

  private transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction, done: (value: T) => void) => void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode)
      let result: T
      let failure: unknown
      const fail = (error: unknown) => {
        failure = error
        tx.abort()
      }
      // Requests must stay inside this live transaction; no asynchronous crypto/network work here.
      tx.oncomplete = () => resolve(result)
      tx.onabort = () =>
        reject(failure ?? new Error('local_storage_unavailable'))
      tx.onerror = () => {
        /* onabort is the single completion path */
      }
      try {
        run(tx, (value) => {
          result = value
        })
      } catch (error) {
        fail(error)
      }
    })
  }

  list(): Promise<LocalCapture[]> {
    return this.transaction(['sessions'], 'readonly', (tx, done) => {
      const request = tx.objectStore('sessions').getAll()
      request.onsuccess = () => done(request.result)
    })
  }

  async create(title: string): Promise<LocalCapture> {
    const capture: LocalCapture = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      createKey: crypto.randomUUID(),
      create: {
        device_id: crypto.randomUUID(),
        lease_key: crypto.randomUUID(),
        retention_mode: 'media',
        title,
      },
      nextSequence: 1,
      durationMs: 0,
      pendingBytes: 0,
      closed: false,
      sealed: false,
    }
    return this.transaction(['sessions'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('sessions')
      const request = store.getAll()
      request.onsuccess = () => {
        if (request.result.some((row: LocalCapture) => !row.sealed)) {
          tx.abort()
          return
        }
        store.add(capture)
        done(capture)
      }
    })
  }

  update(
    id: string,
    change: (current: LocalCapture) => LocalCapture
  ): Promise<LocalCapture> {
    return this.transaction(['sessions'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('sessions')
      const request = store.get(id)
      request.onsuccess = () => {
        if (!request.result) {
          tx.abort()
          return
        }
        const current = change(request.result)
        store.put(current)
        done(current)
      }
    })
  }

  async append(id: string, pcm: Int16Array): Promise<LocalAudioChunk> {
    const audio = pcmWave(pcm)
    const hash = await checksum(audio)
    return this.transaction(['sessions', 'chunks'], 'readwrite', (tx, done) => {
      const sessions = tx.objectStore('sessions')
      const request = sessions.get(id)
      request.onsuccess = () => {
        const capture: LocalCapture | undefined = request.result
        if (
          !capture ||
          capture.closed ||
          capture.nextSequence > MAX_CHUNKS ||
          capture.pendingBytes + audio.byteLength > MAX_PENDING_BYTES
        ) {
          tx.abort()
          return
        }
        const chunk: LocalAudioChunk = {
          captureId: id,
          sequence: capture.nextSequence,
          start_ms: capture.durationMs,
          duration_ms: pcm.length / (SAMPLE_RATE / 1000),
          checksum: hash,
          byte_size: audio.byteLength,
          audio,
        }
        tx.objectStore('chunks').add(chunk)
        sessions.put({
          ...capture,
          nextSequence: capture.nextSequence + 1,
          durationMs: capture.durationMs + chunk.duration_ms,
          pendingBytes: capture.pendingBytes + chunk.byte_size,
        })
        done(chunk)
      }
    })
  }

  chunks(id: string): Promise<LocalAudioChunk[]> {
    return this.transaction(['chunks'], 'readonly', (tx, done) => {
      const request = tx
        .objectStore('chunks')
        .getAll(IDBKeyRange.bound([id, 1], [id, MAX_CHUNKS]))
      request.onsuccess = () => done(request.result)
    })
  }

  acknowledge(id: string, receipt: AudioReceipt): Promise<void> {
    return this.transaction(['sessions', 'chunks'], 'readwrite', (tx, done) => {
      const chunks = tx.objectStore('chunks')
      const request = chunks.get([id, receipt.sequence])
      request.onsuccess = () => {
        const chunk: LocalAudioChunk | undefined = request.result
        if (
          !chunk ||
          !receipt.stored ||
          ['sequence', 'checksum', 'byte_size', 'start_ms', 'duration_ms'].some(
            (key) =>
              chunk[key as keyof LocalAudioChunk] !==
              receipt[key as keyof AudioReceipt]
          )
        ) {
          tx.abort()
          return
        }
        const sessions = tx.objectStore('sessions')
        const parent = sessions.get(id)
        parent.onsuccess = () => {
          if (!parent.result) {
            tx.abort()
            return
          }
          if (chunk.audio)
            sessions.put({
              ...parent.result,
              pendingBytes: parent.result.pendingBytes - chunk.byte_size,
            })
          chunks.put({ ...chunk, audio: undefined, receipt })
          done(undefined)
        }
      }
    })
  }
}
