import { fetchApi } from '@/api/fetchApi'
import type {
  ApiCaptureSession,
  CaptureOperationResponse,
} from '../api/ApiCaptureSession'
import type { AudioReceipt, LocalAudioChunk, LocalCapture } from './journal'
import { isAudioRetention } from './retention'

export async function textAudioAvailable(
  signal: AbortSignal
): Promise<boolean> {
  const result = await fetchApi<{
    text_audio_available: boolean
    text_audio_error: string
  }>('capture-audio-capabilities/', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    cache: 'no-store',
    redirect: 'error',
  })
  return result.text_audio_available === true && result.text_audio_error === ''
}

function checkedCapture(local: LocalCapture, capture: ApiCaptureSession) {
  if (
    local.create.retention_mode === 'text' &&
    (!capture ||
      !isAudioRetention(capture.audio_retention) ||
      capture.audio_retention.mode !== 'text' ||
      capture.device_id !== local.create.device_id ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(capture.id) ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(capture.record_id) ||
      (local.remote &&
        (capture.id !== local.remote.id ||
          capture.record_id !== local.remote.record_id)))
  )
    throw new Error('invalid_text_capture')
  return capture
}

function checkedOperation(
  local: LocalCapture,
  response: CaptureOperationResponse
) {
  if (
    local.create.retention_mode === 'text' &&
    (!response ||
      typeof response.replayed !== 'boolean' ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
        response.operation_id
      ))
  )
    throw new Error('invalid_text_capture_receipt')
  checkedCapture(local, response.capture)
  checkedCapture(local, response.result)
  if (
    local.create.retention_mode === 'text' &&
    (response.capture.id !== response.result.id ||
      response.capture.record_id !== response.result.record_id)
  )
    throw new Error('invalid_text_capture_receipt')
  return response
}

export interface AudioManifest {
  final_sequence: number
  outcome: 'saved' | 'incomplete' | 'empty'
  duration_ms: number
  missing_sequences: number[]
  gaps: Array<{ start_ms: number; end_ms: number }>
  coverage_status: 'unverified'
}

export function captureTransport(signal: AbortSignal) {
  const request = <T>(path: string, options: RequestInit = {}) =>
    fetchApi<T>(`capture-sessions/${path}`, {
      ...options,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      cache: 'no-store',
      redirect: 'error',
    })
  const headers = (local: LocalCapture) => ({
    'X-Capture-Lease': local.create.lease_key,
  })
  return {
    textAudioAvailable: () => textAudioAvailable(signal),
    create: (local: LocalCapture) =>
      request<CaptureOperationResponse>('', {
        method: 'POST',
        headers: { 'Idempotency-Key': local.createKey },
        body: JSON.stringify(local.create),
      }).then((response) => checkedOperation(local, response)),
    read: (local: LocalCapture) =>
      request<ApiCaptureSession>(`${local.remote!.id}/`).then((response) =>
        checkedCapture(local, response)
      ),
    receipts: (local: LocalCapture, after: number) =>
      request<{
        results: AudioReceipt[]
        next_after_sequence: number | null
      }>(`${local.remote!.id}/audio/?after_sequence=${after}`),
    command: (local: LocalCapture) =>
      request<CaptureOperationResponse>(`${local.remote!.id}/commands/`, {
        method: 'POST',
        headers: { ...headers(local), 'Idempotency-Key': local.command!.key },
        body: JSON.stringify(local.command!.body),
      }).then((response) => checkedOperation(local, response)),
    upload: (local: LocalCapture, chunk: LocalAudioChunk) => {
      if (!chunk.audio) throw new Error('missing_local_audio')
      const body = new FormData()
      body.set('device_id', local.create.device_id)
      body.set('sequence', String(chunk.sequence))
      body.set('start_ms', String(chunk.start_ms))
      body.set('checksum', chunk.checksum)
      body.set(
        'audio',
        new Blob([chunk.audio], { type: 'audio/wav' }),
        'chunk.wav'
      )
      return request<AudioReceipt>(`${local.remote!.id}/audio/upload/`, {
        method: 'POST',
        headers: headers(local),
        body,
      })
    },
    seal: (local: LocalCapture) =>
      request<AudioManifest>(`${local.remote!.id}/audio/seal/`, {
        method: 'POST',
        headers: headers(local),
        body: JSON.stringify({
          device_id: local.create.device_id,
          final_sequence: local.nextSequence - 1,
          ...local.sealIntent,
        }),
      }),
  }
}

export type CaptureTransport = ReturnType<typeof captureTransport>
