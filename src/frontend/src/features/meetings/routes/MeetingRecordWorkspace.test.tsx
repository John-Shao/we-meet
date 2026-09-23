import { forwardRef, useImperativeHandle } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { RecordWorkspace } from './MeetingRecordWorkspace'
import type { PlaybackFollowControl } from '../components/RecordPlaybackControls'
import { formatDateTime } from '../recordDateTime'
import { act } from '@testing-library/react'

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
  UploadMediaPlayer: forwardRef(function Player(
    { followControl }: { followControl?: PlaybackFollowControl },
    ref
  ) {
    useImperativeHandle(ref, () => ({ seek: mocks.seek }))
    return (
      <>
        <p>upload-player</p>
        {followControl && (
          <button
            aria-label="followPlayback"
            aria-pressed={followControl.enabled}
            onClick={followControl.onToggle}
          >
            Follow
          </button>
        )}
      </>
    )
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
vi.mock('../components/UploadTranslationPanel', () => ({
  UploadTranslationPanel: () => <p>upload-full-translation</p>,
}))
vi.mock('../components/RecordSummaryPanel', () => ({
  RecordSummaryPanel: ({
    onSourceAudio,
    chaptersOnly,
  }: {
    onSourceAudio?: (ms: number) => void
    chaptersOnly?: boolean
  }) => (
    <div>
      {chaptersOnly ? 'chapters-workspace' : 'summary-workspace'}
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
    capabilities: {
      read_transcript: true,
      read_summary: true,
      play_media: true,
      control_capture: true,
    },
  }
  capture = {
    id: 'capture',
    record_id: 'record',
    status: 'stopped',
    media_status: 'saved',
    started_at: '2026-09-13T00:00:02Z',
  }
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (path.includes('/document-exports/')) return { results: [] }
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
    if (path.includes('/overview/'))
      return {
        revision: 1,
        available: true,
        can_generate: false,
        generation_ready: true,
        job: null,
        version: {
          id: 'overview',
          is_current: true,
          created_at: '2026-09-13T00:00:00Z',
          content: {
            synopsis: 'Recording overview',
            topics: [
              {
                title: 'Topic',
                text: 'Main talking point',
                source_refs: [{ start_ms: 3000 }],
              },
            ],
          },
        },
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

it('routes a human export to its exact read-only source', async () => {
  window.history.replaceState(null, '', '/meeting/records/record?human=old')
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) =>
    path.endsWith('/human-summary/history/old/')
      ? {
          id: 'old',
          revision: 1,
          input_snapshot_id: 'snapshot',
          content: {
            overview: 'Exported human revision',
            decisions: [],
            action_items: [],
            chapters: [],
            open_questions: [],
          },
        }
      : baseline(path, options)
  )
  show()
  await screen.findByText('Exported human revision')
  expect(screen.queryByText('summary-workspace')).toBeNull()
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.queryByText('protected-player')).not.toBeInTheDocument()
})

it.each(['human=', 'human=one&human=two', 'human=one&summary=two'])(
  'rejects ambiguous human source selectors: %s',
  async (selector) => {
    window.history.replaceState(null, '', `/meeting/records/record?${selector}`)
    show()
    await screen.findByText('humanReview.unavailable')
    expect(screen.queryByText('summary-workspace')).toBeNull()
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([path]) => path.includes('/human-summary/'))
    ).toBe(false)
  }
)

it('does not read human history without summary permission', async () => {
  window.history.replaceState(null, '', '/meeting/records/record?human=old')
  record.capabilities = { read_transcript: true, read_summary: false }
  show()
  await screen.findByText('recordAi.unavailable')
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([path]) => path.includes('/human-summary/'))
  ).toBe(false)
})

it('shows owner and actual creation time without requesting documents for a transcript-only reader', async () => {
  record.owner = 'Recording owner'
  record.created_at = '2026-09-19T12:00:00Z'
  record.capabilities = { read_transcript: true, read_summary: false }
  show()
  fireEvent.click(await screen.findByRole('tab', { name: 'library.info' }))
  expect(await screen.findByText('Recording owner')).toBeInTheDocument()
  expect(
    // 走共享格式化件取值：断言的就是「页面渲染的是这一处定义的输出」。
    // 不显式传语言 —— 与组件同一条解析路径（测试里 i18next 单例没初始化，
    // 两边都落到运行时的默认 locale），所以不会跟着宿主时区/语言漂。
    screen.getByText(formatDateTime('2026-09-19T12:00:00Z')!)
  ).toBeInTheDocument()
  expect(screen.queryByText('recordDocuments.title')).toBeNull()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([path]) => path.includes('/document-exports/'))
  ).toBe(false)
})

it.each(['upload', 'audio_recording'])(
  'connects speaker intervals to the %s player only with media capability',
  async (source) => {
    record.source_type = source
    if (source === 'upload') record.capture_id = null
    const baseline = vi.mocked(fetchApi).getMockImplementation()!
    vi.mocked(fetchApi).mockImplementation(async (path, options) => {
      if (path.includes('/speakers/'))
        return {
          results: [
            {
              id: 'speaker',
              identity_type: 'diarized',
              label: 'Speaker A',
              activity: {
                basis: 'recognized_speaker_time',
                status: 'available',
                duration_ms: 2000,
                share_percent: 100,
                timeline: {
                  basis: 'recognized_extent',
                  status: 'available',
                  extent_ms: 6000,
                  intervals: [{ start_ms: 4000, end_ms: 6000 }],
                },
              },
            },
          ],
          next_cursor: null,
        }
      return baseline(path, options)
    })
    show()
    fireEvent.click(
      await screen.findByRole('tab', { name: 'library.speakers' })
    )
    fireEvent.click(await screen.findByText('speakerTimeline.intervals'))
    fireEvent.click(
      screen.getByRole('button', { name: 'speakerTimeline.seek' })
    )
    expect(mocks.seek).toHaveBeenCalledWith(4000)
    record = {
      ...record,
      capabilities: { read_transcript: true, play_media: false },
    }
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['meeting-records', 'owner', 'detail', 'record'],
      })
    })
    await screen.findByText('speakerTimeline.readOnly')
    expect(
      screen.queryByRole('button', { name: 'speakerTimeline.seek' })
    ).not.toBeInTheDocument()
  }
)
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
})

it('opens upload full translation without a capture ID', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  window.history.replaceState(
    null,
    '',
    '/meeting/records/record?tab=translations'
  )
  show()
  expect(await screen.findByText('upload-full-translation')).toBeInTheDocument()
  expect(
    screen.getByRole('tab', { name: 'translationArchive.title' })
  ).toHaveAttribute('aria-selected', 'true')
})

it('opens a standalone document directly from the minutes library without selecting a historical version', async () => {
  window.history.replaceState(null, '', '/meeting/records/record?tab=summary')
  show()
  await screen.findByText('summary-workspace')
  expect(
    screen.getByRole('link', { name: 'minutesLibrary.back' })
  ).toHaveAttribute('href', '/meeting/minutes')
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.queryByText('protected-player')).not.toBeInTheDocument()
  expect(screen.queryByText('Shared original')).not.toBeInTheDocument()
})

it('opens chapter navigation directly and rebases its source time for capture playback', async () => {
  window.history.replaceState(null, '', '/meeting/records/record?tab=chapters')
  show()
  await screen.findByText('Main talking point')
  expect(
    screen.getByRole('tab', { name: 'recordAi.sections.chapters' })
  ).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(
    await screen.findByRole('button', { name: 'recordAi.listenSource 0:03' })
  )
  expect(mocks.seek).toHaveBeenCalledWith(1000)
})

it('exposes recording chapters independently of minutes access', async () => {
  record.capabilities = {
    read_transcript: true,
    read_summary: false,
    play_media: false,
  }
  window.history.replaceState(null, '', '/meeting/records/record?tab=chapters')
  show()
  await screen.findByText('Main talking point')
  expect(
    screen.queryByRole('tab', { name: 'recordAi.sections.chapters' })
  ).toBeInTheDocument()
  expect(screen.queryByText('chapters-workspace')).not.toBeInTheDocument()
})

it('retains a correction draft and its opening revision across a record revision refresh', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  const baseFetch = vi.mocked(fetchApi).getMockImplementation()!
  let correctionRevision = 2
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'PATCH') throw new ApiError(409, {})
    if (path.includes('original-segments'))
      return {
        results: [
          {
            id: 'original',
            text: correctionRevision === 2 ? 'Before' : 'Other editor',
            start_ms: 0,
            end_ms: 1000,
            can_correct: true,
            correction_revision: correctionRevision,
          },
        ],
        next_cursor: null,
      }
    return baseFetch(path, options)
  })
  show()
  fireEvent.click(await screen.findByText('transcriptCorrection.edit'))
  fireEvent.change(
    screen.getByRole('textbox', { name: 'transcriptCorrection.edit' }),
    { target: { value: 'My unsaved draft' } }
  )
  correctionRevision = 3
  record = { ...record, revision: 2 }
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['meeting-records', 'owner', 'detail', 'record'],
    })
  })
  await waitFor(() =>
    expect(
      screen.getByRole('textbox', { name: 'transcriptCorrection.edit' })
    ).toHaveValue('My unsaved draft')
  )
  fireEvent.click(
    await screen.findByRole('button', { name: 'transcriptCorrection.save' })
  )
  await screen.findByText('transcriptCorrection.conflict')
  const patch = vi
    .mocked(fetchApi)
    .mock.calls.find(([, options]) => options?.method === 'PATCH')
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
    text: 'My unsaved draft',
    expected_revision: 2,
  })
  expect(
    screen.getByRole('textbox', { name: 'transcriptCorrection.edit' })
  ).toHaveValue('My unsaved draft')
  fireEvent.click(screen.getByText('transcriptCorrection.cancel'))
  fireEvent.click(screen.getByText('transcriptCorrection.edit'))
  expect(
    screen.getByRole('textbox', { name: 'transcriptCorrection.edit' })
  ).toHaveValue('Other editor')
})

it('reads an owner’s stopped cloud capture without any local journal or device commands', async () => {
  show()
  await screen.findByText('protected-player')
  fireEvent.click(screen.getByText('asr-controls'))
  expect(mocks.seek).toHaveBeenCalledWith(500)
  fireEvent.click(screen.getByRole('tab', { name: 'recordOverview.title' }))
  fireEvent.click(
    await screen.findByRole('button', { name: 'recordAi.listenSource 0:03' })
  )
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
  window.history.replaceState(null, '', '/meeting/records/record?tab=summary')
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
  fireEvent.click(screen.getByRole('tab', { name: 'recordOverview.title' }))
  expect(await screen.findByText('Recording overview')).toBeInTheDocument()
  expect(screen.queryByText('Document decision')).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'recordOverview.openMinutes' })
  ).toHaveAttribute('href', '/meeting/records/record?tab=summary')
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
    screen.queryByRole('tab', { name: 'recordOverview.title' })
  ).toBeInTheDocument()
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
  window.history.replaceState(null, '', '/meeting/records/record?tab=summary')
  show()
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
  const searchInput = () => screen.getByLabelText('library.searchOriginal')
  fireEvent.change(searchInput(), {
    target: { value: ' 中文 & % ' },
  })
  // 提交只剩回车(与列表页 §3.13 同一口径:页面上不再有「搜索」按钮),
  // 所以这里直接提交表单本身。
  fireEvent.submit(searchInput().closest('form')!)
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
  fireEvent.change(searchInput(), {
    target: { value: 'updated' },
  })
  fireEvent.submit(searchInput().closest('form')!)
  await screen.findByText('library.sourceChanged')
  expect(screen.queryByText('Found on a later page')).not.toBeInTheDocument()
  // 清空输入立刻撤销关键词筛选 —— 不必再点一次 ✕ 或「清空」。
  fireEvent.change(searchInput(), { target: { value: '' } })
  await screen.findByText('Exact online source')
})

it('connects upload timestamps to playback without sending an empty speaker filter', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  show()
  const row = (await screen.findByText('Shared original')).closest('article')!
  expect(row).toHaveAttribute('aria-current', 'true')
  fireEvent.click(screen.getByRole('button', { name: '00:00' }))
  expect(mocks.seek).toHaveBeenCalledWith(0)
  for (const [path] of vi
    .mocked(fetchApi)
    .mock.calls.filter(([path]) => path.includes('original-segments'))) {
    expect(new URLSearchParams(path.split('?')[1]).has('speaker')).toBe(false)
  }
})

it('does not offer media or timestamp actions to a transcript-only upload reader', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  record.upload = { can_control: false }
  record.capabilities = {
    read_transcript: true,
    read_summary: true,
    play_media: false,
  }
  show()
  await screen.findByText('Shared original')
  expect(screen.queryByText('upload-player')).not.toBeInTheDocument()
  expect(screen.queryByText('upload-status')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: '00:00' })
  ).not.toBeInTheDocument()
  expect(screen.queryByText('library.backToPlayback')).not.toBeInTheDocument()
})

it('shows upload controls only when the owner control capability is granted', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  record.upload = { can_control: true }
  show()
  expect(await screen.findByText('upload-status')).toBeInTheDocument()
})

it('does not infer upload controls from transcript access on older metadata', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  show()
  await screen.findByText('Shared original')
  expect(screen.queryByText('upload-status')).not.toBeInTheDocument()
})

it('lets the player resume transcript following after browsing and searching', async () => {
  record.source_type = 'upload'
  record.capture_id = null
  show()
  const row = (await screen.findByText('Shared original')).closest('article')!
  fireEvent.wheel(row)
  expect(
    screen.getByRole('button', { name: 'followPlayback' })
  ).toHaveAttribute('aria-pressed', 'false')
  const input = screen.getByLabelText('library.searchOriginal')
  fireEvent.change(input, { target: { value: 'release' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([path]) => path.includes('q=release'))
    ).toBe(true)
  )
  fireEvent.click(screen.getByRole('button', { name: 'followPlayback' }))
  await waitFor(() =>
    expect(screen.getByLabelText('library.searchOriginal')).toHaveValue('')
  )
  expect(
    screen.getByRole('button', { name: 'followPlayback' })
  ).toHaveAttribute('aria-pressed', 'true')
  expect(
    screen.queryByRole('button', { name: 'library.backToPlayback' })
  ).not.toBeInTheDocument()
})
