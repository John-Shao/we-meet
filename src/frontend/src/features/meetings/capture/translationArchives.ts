import { fetchApi } from '@/api/fetchApi'
import {
  isConfiguration,
  object,
  positive,
  uuid,
  type TranslationConfiguration,
} from './translationProtocol'

export interface CaptureArchive {
  id: string
  run_id: string
  capture_id: string
  generation: number
  configuration: TranslationConfiguration
  status: 'capturing' | 'complete' | 'incomplete'
  segment_count: number
  created_at: string
}
export interface CaptureTranslationSegment {
  id: string
  sequence: number
  source_capture_id: string
  direction: 'forward' | 'reverse'
  target: 'zh' | 'en'
  text: string
  received_at: string
  timing_basis: 'delivery'
  original_id: null
}
interface Page<T> {
  results: T[]
  next_cursor: string | null
}
type Source = { viewerId: string; captureId: string; recordId: string }
const timestamp = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
const status = (value: unknown) =>
  typeof value === 'string' &&
  ['capturing', 'complete', 'incomplete'].includes(value)
const cursor = (value: unknown) =>
  value === null ||
  (typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/\s/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32))
function page(
  value: unknown,
  source: Source,
  maximum: number
): value is Record<string, unknown> & { results: Record<string, unknown>[] } {
  return (
    object(value) &&
    value.capture_id === source.captureId &&
    value.record_id === source.recordId &&
    Array.isArray(value.results) &&
    value.results.length <= maximum &&
    value.results.every(object) &&
    cursor(value.next_cursor)
  )
}
export function isArchivePage(
  value: unknown,
  source: Source
): value is Page<CaptureArchive> {
  return (
    page(value, source, 30) &&
    new Set(value.results.map((row) => row.id)).size === value.results.length &&
    value.results.every(
      (row) =>
        uuid(row.id) &&
        uuid(row.run_id) &&
        row.capture_id === source.captureId &&
        positive(row.generation) &&
        isConfiguration(row.configuration) &&
        row.configuration.save_translations &&
        status(row.status) &&
        typeof row.segment_count === 'number' &&
        Number.isSafeInteger(row.segment_count) &&
        row.segment_count >= 0 &&
        row.segment_count <= 20000 &&
        timestamp(row.created_at)
    )
  )
}
export function isSegmentPage(
  value: unknown,
  source: Source,
  archive: CaptureArchive
): value is Page<CaptureTranslationSegment> & {
  archive_status: CaptureArchive['status']
} {
  return (
    page(value, source, 50) &&
    value.archive_id === archive.id &&
    value.run_id === archive.run_id &&
    value.generation === archive.generation &&
    status(value.archive_status) &&
    new Set(value.results.map((row) => row.id)).size === value.results.length &&
    value.results.every(
      (row, index) =>
        uuid(row.id) &&
        positive(row.sequence) &&
        (index === 0 ||
          row.sequence > (value.results[index - 1].sequence as number)) &&
        row.source_capture_id === source.captureId &&
        (row.direction === 'forward' ||
          (row.direction === 'reverse' &&
            archive.configuration.mode === 'push_to_talk')) &&
        row.target ===
          archive.configuration[
            row.direction === 'reverse' ? 'source_language' : 'target_language'
          ] &&
        typeof row.text === 'string' &&
        row.text.trim().length > 0 &&
        row.text.length <= 20000 &&
        timestamp(row.received_at) &&
        row.timing_basis === 'delivery' &&
        row.original_id === null
    )
  )
}
export function captureArchiveApi(
  source: Source,
  current: () => boolean,
  signal: AbortSignal
) {
  if (![source.viewerId, source.captureId, source.recordId].every(uuid))
    throw new Error('invalid_archive_source')
  const request = async (path: string, after: string) => {
    if (!current() || (after && !cursor(after)))
      throw new Error('archive_source_changed')
    const result = await fetchApi<unknown>(
      `capture-sessions/${source.captureId}/translation/archives/${path}?${new URLSearchParams(after ? { cursor: after } : {})}`,
      {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      }
    )
    if (!current()) throw new Error('archive_source_changed')
    return result
  }
  return {
    list: async (after = '') => {
      const result = await request('', after)
      if (!isArchivePage(result, source))
        throw new Error('invalid_capture_archives')
      return result
    },
    segments: async (archive: CaptureArchive, after = '') => {
      if (!uuid(archive.id) || archive.capture_id !== source.captureId)
        throw new Error('invalid_capture_archive')
      const result = await request(`${archive.id}/`, after)
      if (!isSegmentPage(result, source, archive))
        throw new Error('invalid_capture_segments')
      return result
    },
  }
}
