import { fetchApi, fetchApiBlob } from '@/api/fetchApi'
import type { AudioReceipt } from './journal'
import type { AudioManifest } from './transport'
import { checksum, MAX_CHUNKS } from './pcm'

export interface AudioPlaylist {
  chunks: AudioReceipt[]
  manifest: AudioManifest | null
}

export const checkAudioAccess = (captureId: string, signal: AbortSignal) =>
  fetchApi(
    `capture-sessions/${encodeURIComponent(captureId)}/audio/?after_sequence=${MAX_CHUNKS}`,
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      cache: 'no-store',
    }
  )

export async function audioPlaylist(
  captureId: string,
  signal: AbortSignal
): Promise<AudioPlaylist> {
  const chunks: AudioReceipt[] = []
  let after = 0
  let manifest: AudioManifest | null = null
  for (let page = 0; page < 44; page++) {
    const result = await fetchApi<{
      results: AudioReceipt[]
      manifest: AudioManifest | null
      next_after_sequence: number | null
    }>(
      `capture-sessions/${encodeURIComponent(captureId)}/audio/?after_sequence=${after}`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        cache: 'no-store',
      }
    )
    manifest = result.manifest
    for (const chunk of result.results) {
      if (!chunk.stored) continue
      if (
        chunk.sequence <= (chunks.at(-1)?.sequence ?? 0) ||
        chunk.sequence > MAX_CHUNKS ||
        chunk.duration_ms < 1 ||
        chunk.duration_ms > 10000 ||
        chunk.start_ms < 0 ||
        chunk.byte_size > 320044 ||
        chunk.byte_size < 76 ||
        chunk.start_ms <
          (chunks.at(-1)?.start_ms ?? 0) + (chunks.at(-1)?.duration_ms ?? 0)
      )
        throw new Error('invalid_audio_receipts')
      chunks.push(chunk)
    }
    if (result.next_after_sequence === null) return { chunks, manifest }
    if (result.next_after_sequence <= after)
      throw new Error('invalid_audio_cursor')
    after = result.next_after_sequence
  }
  throw new Error('audio_playlist_too_large')
}

export async function audioChunk(
  captureId: string,
  chunk: AudioReceipt,
  signal: AbortSignal
) {
  const audio = await fetchApiBlob(
    `capture-sessions/${encodeURIComponent(captureId)}/audio/${encodeURIComponent(chunk.id)}/`,
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      cache: 'no-store',
    },
    320044
  )
  if (
    audio.size !== chunk.byte_size ||
    (await checksum(await audio.arrayBuffer())) !== chunk.checksum
  )
    throw new Error('audio_integrity_failed')
  return audio
}

/** Return a gap explicitly. Seeking never silently snaps missing audio to another speaker. */
export function locateAudio(chunks: AudioReceipt[], milliseconds: number) {
  const index = chunks.findIndex(
    (chunk) =>
      milliseconds >= chunk.start_ms &&
      milliseconds < chunk.start_ms + chunk.duration_ms
  )
  return index >= 0
    ? { index, offset: (milliseconds - chunks[index].start_ms) / 1000 }
    : null
}
