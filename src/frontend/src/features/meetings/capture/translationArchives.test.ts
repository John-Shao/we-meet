import { beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { source, run } from './translation.testFixtures'
import {
  captureArchiveApi,
  isArchivePage,
  isSegmentPage,
  type CaptureArchive,
} from './translationArchives'
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
const archive = (): CaptureArchive => ({
  id: '66666666-6666-4666-8666-666666666666',
  capture_id: source.captureId,
  run_id: run().id,
  generation: 1,
  configuration: {
    ...run().configuration,
    save_translations: true,
    mode: 'push_to_talk',
  },
  status: 'complete',
  segment_count: 2,
  created_at: new Date().toISOString(),
})
const list = () => ({
  capture_id: source.captureId,
  record_id: source.recordId,
  results: [archive()],
  next_cursor: null,
})
const segments = () => ({
  capture_id: source.captureId,
  record_id: source.recordId,
  archive_id: archive().id,
  run_id: archive().run_id,
  generation: 1,
  archive_status: 'complete',
  next_cursor: null,
  results: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      sequence: 1,
      source_capture_id: source.captureId,
      direction: 'reverse',
      target: 'zh',
      text: 'Saved translation',
      received_at: new Date().toISOString(),
      timing_basis: 'delivery',
      original_id: null,
    },
  ],
})
beforeEach(() => vi.clearAllMocks())
it('accepts exact retained capture provenance and reverse-language text', () => {
  expect(isArchivePage(list(), source)).toBe(true)
  expect(isSegmentPage(segments(), source, archive())).toBe(true)
})
it.each(['capture_id', 'record_id'])('rejects mismatched page %s', (field) => {
  expect(
    isArchivePage({ ...list(), [field]: crypto.randomUUID() }, source)
  ).toBe(false)
  expect(
    isSegmentPage(
      { ...segments(), [field]: crypto.randomUUID() },
      source,
      archive()
    )
  ).toBe(false)
})
it('rejects nonconsensual or unexpected model configuration', () => {
  const value = list()
  value.results[0].configuration.save_translations = false
  expect(isArchivePage(value, source)).toBe(false)
  value.results[0].configuration.save_translations = true
  expect(
    isArchivePage(
      {
        ...value,
        results: [
          {
            ...archive(),
            configuration: {
              ...archive().configuration,
              model: 'unselected-model',
            },
          },
        ],
      },
      source
    )
  ).toBe(false)
})
it('rejects wrong run, generation, fabricated media position and contradictory language', () => {
  for (const patch of [{ run_id: crypto.randomUUID() }, { generation: 2 }])
    expect(isSegmentPage({ ...segments(), ...patch }, source, archive())).toBe(
      false
    )
  for (const patch of [
    { source_capture_id: crypto.randomUUID() },
    { target: 'en' },
    { original_id: 'fabricated' },
    { timing_basis: 'audio' },
  ]) {
    const value = segments()
    expect(
      isSegmentPage(
        { ...value, results: [{ ...value.results[0], ...patch }] },
        source,
        archive()
      )
    ).toBe(false)
  }
})
it('bounds pages, cursor size and rejects duplicate or unordered segments', () => {
  expect(
    isArchivePage({ ...list(), next_cursor: 'x'.repeat(2049) }, source)
  ).toBe(false)
  expect(
    isArchivePage({ ...list(), results: Array(31).fill(archive()) }, source)
  ).toBe(false)
  const value = segments()
  expect(
    isSegmentPage(
      { ...value, results: [value.results[0], value.results[0]] },
      source,
      archive()
    )
  ).toBe(false)
  expect(
    isSegmentPage(
      {
        ...value,
        results: [
          value.results[0],
          { ...value.results[0], id: crypto.randomUUID(), sequence: 1 },
        ],
      },
      source,
      archive()
    )
  ).toBe(false)
})
it('uses bounded no-store reads and encodes only opaque cursor values', async () => {
  vi.mocked(fetchApi).mockResolvedValue(list())
  await captureArchiveApi(
    source,
    () => true,
    new AbortController().signal
  ).list('a+/=')
  expect(fetchApi).toHaveBeenCalledWith(
    expect.stringContaining('cursor=a%2B%2F%3D'),
    expect.objectContaining({ cache: 'no-store', redirect: 'error' })
  )
  expect(vi.mocked(fetchApi).mock.calls[0][1]).not.toHaveProperty('headers')
})
it('drops late data after a source or account change', async () => {
  let resolve: (value: unknown) => void = () => undefined
  vi.mocked(fetchApi).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  let current = true
  const result = captureArchiveApi(
    source,
    () => current,
    new AbortController().signal
  ).list()
  current = false
  resolve(list())
  await expect(result).rejects.toThrow('archive_source_changed')
})
