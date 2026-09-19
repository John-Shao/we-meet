import { forwardRef, useImperativeHandle } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { RecordWorkspace } from './MeetingRecordWorkspace'

const mocks = vi.hoisted(() => ({ seek: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../components/CaptureAudioPlayer', () => ({
  CaptureAudioPlayer: forwardRef(function Player(_, ref) {
    useImperativeHandle(ref, () => ({ seek: mocks.seek }))
    return <p>protected-player</p>
  }),
}))
vi.mock('../components/UploadMediaPlayer', () => ({
  UploadMediaPlayer: forwardRef(function Player(_, ref) {
    useImperativeHandle(ref, () => ({ seek: mocks.seek }))
    return <p>upload-player</p>
  }),
}))
vi.mock('../components/RecordingUpload', () => ({
  UploadedRecordingStatus: () => <p>upload-status</p>,
}))
vi.mock('../components/CaptureTranscriptionPanel', () => ({
  CaptureTranscriptionPanel: ({
    onSource,
  }: {
    onSource: (ms: number) => void
  }) => <button onClick={() => onSource(500)}>asr-controls</button>,
}))
vi.mock('../components/CaptureTranslationArchives', () => ({
  CaptureTranslationArchives: ({
    viewerId,
    recordId,
    captureId,
  }: {
    viewerId: string
    recordId: string
    captureId: string
  }) => <p>{`capture-translations:${viewerId}:${recordId}:${captureId}`}</p>,
}))
vi.mock('../components/RecordSummaryPanel', () => ({
  RecordSummaryPanel: ({
    onSourceAudio,
  }: {
    onSourceAudio?: (ms: number) => void
  }) => (
    <div>
      summary-workspace
      {onSourceAudio && (
        <button onClick={() => onSourceAudio(3000)}>summary-audio</button>
      )}
    </div>
  ),
}))
let client: QueryClient
let record: Record<string, unknown>
let capture: Record<string, unknown>
function show(viewerId = 'owner', recordId = 'record') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordWorkspace
        key={`${viewerId}:${recordId}`}
        viewerId={viewerId}
        recordId={recordId}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  record = {
    id: 'record',
    title: 'Private recording',
    source_type: 'audio_recording',
    origin_at: '2026-09-13T00:00:00Z',
    revision: 1,
    capture_id: 'capture',
    capabilities: { read_transcript: true, read_summary: true },
  }
  capture = {
    id: 'capture',
    record_id: 'record',
    status: 'stopped',
    media_status: 'saved',
    started_at: '2026-09-13T00:00:02Z',
  }
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (path.startsWith('capture-sessions/')) return capture
    if (path.includes('original-segments'))
      return {
        results: [{ id: 'original', text: 'Shared original', start_ms: 0 }],
        next_cursor: null,
      }
    if (path.includes('/transcripts/'))
      return {
        results: [
          {
            id: 'online',
            text: 'Exact online source',
            started_at: '2026-09-13T00:00:00Z',
          },
        ],
        next_cursor: null,
      }
    if (path.includes('/summaries/'))
      return {
        results: [
          { id: 'old', status: 'success', content: 'Exact legacy minutes' },
        ],
      }
    return record
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

it('opens the summary tab directly from the minutes library without selecting a historical version', async () => {
  window.history.replaceState(null, '', '/meeting/records/record?tab=summary')
  show()
  await screen.findByText('summary-workspace')
  expect(
    screen.getByRole('link', { name: 'minutesLibrary.back' })
  ).toHaveAttribute('href', '/meeting/minutes')
  expect(screen.getByRole('tab', { name: 'library.minutes' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(screen.queryByText('Shared original')).not.toBeInTheDocument()
})

it('reads an owner’s stopped cloud capture without any local journal or device commands', async () => {
  show()
  await screen.findByText('protected-player')
  fireEvent.click(screen.getByText('asr-controls'))
  expect(mocks.seek).toHaveBeenCalledWith(500)
  fireEvent.click(screen.getByRole('tab', { name: 'library.minutes' }))
  fireEvent.click(await screen.findByText('summary-audio'))
  expect(mocks.seek).toHaveBeenCalledWith(1000) // Record time to capture time.
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.every(
        ([, options]) => !options?.method || options.method === 'GET'
      )
  ).toBe(true)
})

it('does not mount audio or ASR controls for a recording still running on another device', async () => {
  capture.status = 'paused'
  show()
  await screen.findByText('library.originalDevice')
  expect(screen.queryByText('protected-player')).not.toBeInTheDocument()
  expect(screen.queryByText('asr-controls')).not.toBeInTheDocument()
  expect(await screen.findByText('Shared original')).toBeInTheDocument()
})

it('summary-only shares never request original text, capture state or audio', async () => {
  record.capture_id = null
  record.capabilities = { read_summary: true, read_transcript: false }
  show('reader')
  await screen.findByText('summary-workspace')
  expect(
    screen.queryByRole('tab', { name: 'library.text' })
  ).not.toBeInTheDocument()
  expect(screen.queryByText('summary-audio')).not.toBeInTheDocument()
  expect(vi.mocked(fetchApi).mock.calls.map(([path]) => path)).toEqual([
    'meeting-records/record/',
  ])
})

it('edits uploaded text using the server capability and reaches its summary workspace', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  let text = 'Imported words'
  let version = 0
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'PATCH') {
      expect(JSON.parse(options.body as string)).toEqual({
        text: 'Corrected import',
        expected_revision: 0,
      })
      text = 'Corrected import'
      version = 1
      record.revision = 2
      return {
        id: 'original',
        text,
        correction_revision: version,
        record_revision: 2,
      }
    }
    if (path.includes('original-segments'))
      return {
        results: [
          {
            id: 'original',
            text,
            start_ms: 0,
            can_correct: true,
            correction_revision: version,
          },
        ],
        next_cursor: null,
      }
    return baseline(path, options, ...rest)
  })
  show()
  fireEvent.click(await screen.findByText('transcriptCorrection.edit'))
  fireEvent.change(
    screen.getByRole('textbox', { name: 'transcriptCorrection.edit' }),
    { target: { value: 'Corrected import' } }
  )
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  await screen.findByText('Corrected import')
  fireEvent.click(screen.getByRole('tab', { name: 'library.minutes' }))
  expect(await screen.findByText('summary-workspace')).toBeInTheDocument()
})

it('transcript-only shares read originals but cannot mount paid or private capture controls', async () => {
  record.capture_id = null
  record.capabilities = { read_summary: false, read_transcript: true }
  show('reader')
  await screen.findByText('Shared original')
  expect(screen.queryByText('asr-controls')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('tab', { name: 'translationArchive.title' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('tab', { name: 'library.minutes' })
  ).not.toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.every(([path]) => path.startsWith('meeting-records/record/'))
  ).toBe(true)
})

it('opens saved translations through the exact owner capture', async () => {
  show()
  fireEvent.click(
    await screen.findByRole('tab', { name: 'translationArchive.title' })
  )
  expect(
    await screen.findByText('capture-translations:owner:record:capture')
  ).toBeInTheDocument()
})

it('unmounts private content and the player when access is revoked', async () => {
  show()
  await screen.findByText('protected-player')
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(404, {}))
  await client.invalidateQueries({
    queryKey: ['meeting-records', 'owner', 'detail', 'record'],
  })
  await waitFor(() =>
    expect(screen.queryByText('protected-player')).not.toBeInTheDocument()
  )
  expect(screen.queryByText('Private recording')).not.toBeInTheDocument()
  expect(screen.queryByText('asr-controls')).not.toBeInTheDocument()
})

it('reads old online material only through the immutable record ID', async () => {
  record.capture_id = null
  record.source_type = 'meeting'
  show()
  await screen.findByText('Exact online source')
  fireEvent.click(screen.getByRole('tab', { name: 'library.minutes' }))
  await screen.findByText('Exact legacy minutes')
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.every(([path]) => path.startsWith('meeting-records/record/'))
  ).toBe(true)
})

it('searches the complete original with a revision fence and hides stale results', async () => {
  record.capture_id = null
  record.source_type = 'meeting'
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (path.includes('/transcripts/')) {
      const params = new URL(path, 'https://fixture.invalid').searchParams
      expect(params.get('expected_revision')).toBe('1')
      if (params.get('q') === 'updated') throw new ApiError(409, {})
      if (params.get('q'))
        return {
          results: [
            {
              id: 'found',
              text: 'Found on a later page',
              started_at: '2026-09-13T00:00:00Z',
            },
          ],
          next_cursor: null,
        }
    }
    return baseline(path, options, ...rest)
  })
  show()
  await screen.findByText('Exact online source')
  fireEvent.change(screen.getByLabelText('library.searchOriginal'), {
    target: { value: ' 中文 & % ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.searchButton' }))
  await screen.findByText('Found on a later page')
  expect(screen.queryByText('Exact online source')).not.toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(
        ([path]) =>
          new URL(path, 'https://fixture.invalid').searchParams.get('q') ===
          '中文 & %'
      )
  ).toBe(true)
  fireEvent.change(screen.getByLabelText('library.searchOriginal'), {
    target: { value: 'updated' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'library.searchButton' }))
  await screen.findByText('library.sourceChanged')
  expect(screen.queryByText('Found on a later page')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'library.clearSearch' }))
  await screen.findByText('Exact online source')
})


it('connects upload timestamps to playback without sending an empty speaker filter', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  show()
  const row = (await screen.findByText('Shared original')).closest('article')!
  expect(row).toHaveAttribute('aria-current', 'true')
  fireEvent.click(screen.getByRole('button', { name: '0:00' }))
  expect(mocks.seek).toHaveBeenCalledWith(0)
  for (const [path] of vi.mocked(fetchApi).mock.calls.filter(([path]) => path.includes('original-segments'))) {
    expect(new URLSearchParams(path.split('?')[1]).has('speaker')).toBe(false)
  }
})
