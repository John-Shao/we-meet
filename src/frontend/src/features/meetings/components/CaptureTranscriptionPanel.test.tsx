import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type {
  ApiCaptureSession,
  CaptureAudioRetention,
} from '../api/ApiCaptureSession'
import { CaptureTranscriptionPanel } from './CaptureTranscriptionPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('./RecordSummaryPanel', () => ({
  RecordSummaryPanel: ({
    onSourceAudio,
  }: {
    onSourceAudio?: (time: number) => void
  }) => (
    <button disabled={!onSourceAudio} onClick={() => onSourceAudio?.(1200)}>
      summary-source
    </button>
  ),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/primitives', () => ({
  SearchBox: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (value: string) => void
    placeholder: string
  }) => (
    <input
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: React.ReactNode
    onPress?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
let client: QueryClient
let status: {
  audio_retention?: CaptureAudioRetention
  available: boolean
  live_available?: boolean
  summary_available?: boolean
  staged_summary_available?: boolean
  active_job_id: string | null
  results: Array<{
    id: string
    status: string
    generation: number
    mode?: 'live' | 'sealed'
    final_count?: number
    error_code?: string
  }>
}
const capture = {
  id: 'capture',
  record_id: 'record',
  media_status: 'saved',
  status: 'stopped',
} as ApiCaptureSession
const onSource = vi.fn()
const posts = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
function show(source = capture) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CaptureTranscriptionPanel
        viewerId="owner"
        capture={source}
        onSource={onSource}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  status = { available: true, active_job_id: null, results: [] }
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return { job: { id: 'job' } }
    if (path.includes('original-segments'))
      return {
        results: [{ id: 'text', start_ms: 2000, text: 'Confirmed original' }],
        next_cursor: null,
      }
    return status
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
  sessionStorage.clear()
})

it('shows an explicit no-speech explanation without automatic retry', async () => {
  status.results = [
    {
      id: 'empty',
      status: 'incomplete',
      generation: 1,
      final_count: 0,
      error_code: 'no_speech_detected',
    },
  ]
  show()
  expect(await screen.findByText('asr.noSpeechHint')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('asr.noSpeech')
  expect(posts()).toHaveLength(0)
})

it.each(['', 'provider_or_delivery_incomplete'])(
  'does not reinterpret generic failures as silence (%s)',
  async (error_code) => {
    status.results = [
      {
        id: 'failed',
        status: 'incomplete',
        generation: 1,
        final_count: 0,
        error_code,
      },
    ]
    show()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'asr.status.incomplete'
      )
    )
    expect(screen.queryByText('asr.noSpeechHint')).not.toBeInTheDocument()
  }
)

it('does not label partial text as no speech', async () => {
  status.results = [
    {
      id: 'partial',
      status: 'incomplete',
      generation: 1,
      final_count: 1,
      error_code: 'no_speech_detected',
    },
  ]
  show()
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'asr.status.incomplete'
    )
  )
  expect(screen.queryByText('asr.noSpeechHint')).not.toBeInTheDocument()
})

it('keeps the previous published transcript after an empty attempt', async () => {
  status.active_job_id = 'old-success'
  status.results = [
    {
      id: 'empty',
      status: 'incomplete',
      generation: 2,
      final_count: 0,
      error_code: 'no_speech_detected',
    },
  ]
  show()
  await screen.findByText('asr.noSpeechHint')
  expect(await screen.findByText('Confirmed original')).toBeInTheDocument()
  expect(posts()).toHaveLength(0)
})

it('refreshes the mounted transcript after correction and guards the next edit and restore', async () => {
  status.active_job_id = 'published'
  let text = 'Original text'
  let revision = 0
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (!path.includes('original-segments')) return status
    if (options?.method === 'PATCH') {
      const body = JSON.parse(options.body as string)
      expect(body.expected_revision).toBe(revision)
      text = body.text
      revision++
      return {
        id: 'text',
        text,
        original_text: 'Original text',
        is_corrected: true,
        correction_revision: revision,
        record_revision: revision + 1,
      }
    }
    if (options?.method === 'DELETE') {
      expect(
        new URL(path, 'https://fixture.invalid').searchParams.get(
          'expected_revision'
        )
      ).toBe(String(revision))
      text = 'Original text'
      revision++
      return {
        id: 'text',
        text,
        original_text: text,
        is_corrected: false,
        correction_revision: revision,
        record_revision: revision + 1,
      }
    }
    return {
      results: [
        {
          id: 'text',
          start_ms: 0,
          text,
          original_text: 'Original text',
          is_corrected: text !== 'Original text',
          can_correct: true,
          correction_revision: revision,
        },
      ],
      next_cursor: null,
    }
  })
  show()
  await screen.findByText('Original text')
  for (const next of ['First correction', 'Second correction']) {
    fireEvent.click(screen.getByText('transcriptCorrection.edit'))
    fireEvent.change(
      screen.getByRole('textbox', { name: 'transcriptCorrection.edit' }),
      { target: { value: next } }
    )
    fireEvent.click(screen.getByText('transcriptCorrection.save'))
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'transcriptCorrection.edit' })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByText(next)).toBeInTheDocument()
  }
  fireEvent.click(screen.getByText('transcriptCorrection.restore'))
  await screen.findByText('Original text')
  expect(revision).toBe(3)
  expect(
    screen.queryByText('transcriptCorrection.editedBadge')
  ).not.toBeInTheDocument()
})

it('keeps the editor draft when saving fails with a network error', async () => {
  status.active_job_id = 'published'
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'PATCH') throw new TypeError('Network unavailable')
    if (path.includes('original-segments'))
      return {
        results: [
          {
            id: 'text',
            start_ms: 0,
            text: 'Before',
            correction_revision: 0,
            can_correct: true,
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
    { target: { value: 'Unsaved draft' } }
  )
  fireEvent.click(screen.getByText('transcriptCorrection.save'))
  await screen.findByText('transcriptCorrection.failed')
  expect(
    screen.getByRole('textbox', { name: 'transcriptCorrection.edit' })
  ).toHaveValue('Unsaved draft')
})

it('opens the summary workspace lazily and links citations to playback', async () => {
  status.summary_available = true
  const view = show()
  const toggle = await screen.findByText('asr.summary')
  expect(screen.queryByText('summary-source')).not.toBeInTheDocument()
  const details = toggle.closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  fireEvent.click(await screen.findByText('summary-source'))
  expect(onSource).toHaveBeenCalledWith(1200)
  view.unmount()
})

it('opens live summaries lazily with audio playback unavailable during recording', async () => {
  status.live_available = true
  status.staged_summary_available = true
  show({ ...capture, status: 'recording', media_status: 'uploading' })
  const toggle = await screen.findByText('asr.liveSummary')
  expect(screen.queryByText('summary-source')).not.toBeInTheDocument()
  const details = toggle.closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(await screen.findByText('summary-source')).toBeDisabled()
  expect(screen.getByText('asr.liveSummaryHint')).toBeInTheDocument()
  expect(posts()).toHaveLength(0)
})

it('does not advertise live summaries on a backend with only final summaries', async () => {
  status.live_available = true
  status.summary_available = true
  show({ ...capture, status: 'recording', media_status: 'uploading' })
  await screen.findByRole('button', { name: 'asr.liveStart' })
  expect(screen.queryByText('asr.liveSummary')).not.toBeInTheDocument()
  expect(screen.queryByText('asr.summary')).not.toBeInTheDocument()
})

it('starts live ASR explicitly during recording without changing audio controls', async () => {
  status.live_available = true
  show({ ...capture, status: 'recording', media_status: 'uploading' })
  const button = await screen.findByRole('button', { name: 'asr.liveStart' })
  expect(posts()).toHaveLength(0)
  fireEvent.click(button)
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({
    expected_job_id: null,
    allow_incomplete: false,
    live: true,
  })
  expect(posts()[0][0]).toBe('capture-sessions/capture/transcription/')
})

it('does not offer a live start when the real-time feature is unavailable', async () => {
  show({ ...capture, status: 'recording', media_status: 'uploading' })
  await waitFor(() =>
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  )
  expect(
    screen.queryByRole('button', { name: 'asr.liveStart' })
  ).not.toBeInTheDocument()
  expect(posts()).toHaveLength(0)
})

it('retains live mode when reconciling an uncertain intent after recording ends', async () => {
  status.live_available = true
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'POST') throw new TypeError('connection lost')
    return baseline(path, options, ...rest)
  })
  const view = show({ ...capture, status: 'recording' })
  fireEvent.click(await screen.findByRole('button', { name: 'asr.liveStart' }))
  await screen.findByText('asr.uncertain')
  const original = posts()[0][1]!
  view.unmount()
  client.clear()
  vi.mocked(fetchApi).mockImplementation(baseline)
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'asr.recover' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[1][1]!.body).toEqual(original.body)
  expect(posts()[1][1]!.headers).toEqual(original.headers)
})

it('searches the published generation and resets its cursor when the query changes', async () => {
  status.active_job_id = 'published'
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (path.includes('original-segments')) {
      const params = new URL(path, 'https://fixture.invalid').searchParams
      expect(params.get('transcription_job_id')).toBe('published')
      if (params.get('q')) {
        expect(params.get('cursor')).toBe('')
        return {
          results: [{ id: 'found', text: 'Search match', start_ms: 5000 }],
          next_cursor: null,
        }
      }
      if (!params.get('cursor'))
        return {
          results: [{ id: 'one', text: 'First page', start_ms: 0 }],
          next_cursor: 'next-token',
        }
      return {
        results: [{ id: 'two', text: 'Second page', start_ms: 1000 }],
        next_cursor: null,
      }
    }
    return baseline(path, options, ...rest)
  })
  show()
  await screen.findByText('First page')
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await screen.findByText('Second page')
  fireEvent.change(screen.getByLabelText('library.searchOriginal'), {
    target: { value: '全文' },
  })
  // The local button test double does not forward type; submit the form itself.
  fireEvent.submit(
    screen.getByLabelText('library.searchOriginal').closest('form')!
  )
  await screen.findByText('Search match')
  expect(screen.queryByText('Second page')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'previous' })
  ).not.toBeInTheDocument()
})

it('uses the backend cursor token while keeping the published version pinned', async () => {
  status = { available: true, active_job_id: 'published', results: [] }
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (path.includes('original-segments'))
      return path.includes('cursor=page-two')
        ? {
            results: [{ id: 'last', start_ms: 5000, text: 'Last page' }],
            next_cursor: null,
          }
        : {
            results: [{ id: 'first', start_ms: 0, text: 'First page' }],
            next_cursor: 'page-two',
          }
    return baseline(path, options, ...rest)
  })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'next' }))
  await screen.findByText('Last page')
  expect(screen.queryByText('First page')).not.toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([path]) =>
        path.includes('transcription_job_id=published&cursor=page-two')
      )
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'previous' }))
  await screen.findByText('First page')
})

it('requires incomplete audio acknowledgement before a paid intent', async () => {
  show({ ...capture, media_status: 'incomplete' })
  const start = await screen.findByRole('button', { name: 'asr.start' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(start)
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({
    expected_job_id: null,
    allow_incomplete: true,
  })
})

it('recovers the exact ambiguous request after remount', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'POST') throw new TypeError('connection lost')
    return baseline(path, options, ...rest)
  })
  const view = show()
  fireEvent.click(await screen.findByRole('button', { name: 'asr.start' }))
  await screen.findByText('asr.uncertain')
  const first = posts()[0][1]!
  view.unmount()
  client.clear()
  vi.mocked(fetchApi).mockImplementation(baseline)
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'asr.recover' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[1][1]!.headers).toEqual(first.headers)
  expect(posts()[1][1]!.body).toBe(first.body)
  await waitFor(() =>
    expect(sessionStorage.getItem('capture-asr:owner:capture')).toBeNull()
  )
})

it('retains published text during retry and links the original audio', async () => {
  status = {
    available: true,
    active_job_id: 'published',
    results: [{ id: 'retry', status: 'running', generation: 2 }],
  }
  show()
  await screen.findByText('Confirmed original')
  expect(screen.getByRole('button', { name: 'asr.retry' })).toBeDisabled()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([path]) =>
        path.includes('transcription_job_id=published')
      )
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'asr.source' }))
  expect(onSource).toHaveBeenCalledWith(2000)
  fireEvent.click(screen.getByRole('button', { name: 'asr.cancel' }))
  await waitFor(() =>
    expect(posts()[0][0]).toBe(
      'capture-sessions/capture/transcription/retry/cancel/'
    )
  )
})

it('hides cached originals after current access fails', async () => {
  status = {
    available: true,
    active_job_id: 'published',
    results: [{ id: 'published', status: 'succeeded', generation: 1 }],
  }
  show()
  await screen.findByText('Confirmed original')
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(403, {}))
  fireEvent.click(screen.getByRole('button', { name: 'asr.refresh' }))
  await screen.findByText('asr.denied')
  expect(screen.queryByText('Confirmed original')).not.toBeInTheDocument()
})

it('aborts creation on leave and retains its recovery intent', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
    if (options?.method === 'POST') return new Promise(() => undefined)
    return baseline(path, options, ...rest)
  })
  const view = show()
  fireEvent.click(await screen.findByRole('button', { name: 'asr.start' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  const signal = posts()[0][1]!.signal!
  view.unmount()
  expect(signal.aborted).toBe(true)
  expect(sessionStorage.getItem('capture-asr:owner:capture')).not.toBeNull()
})

const retention = (): CaptureAudioRetention => ({
  mode: 'text',
  temporary_until: new Date(Date.now() + 3600000).toISOString(),
  retry_until: new Date(Date.now() + 1800000).toISOString(),
  expired: false,
  cleanup_status: 'not_started',
  cleanup_error: '',
  deleted_at: null,
})

it('shows text-only cleanup separately and suppresses source playback', async () => {
  status.audio_retention = {
    ...retention(),
    cleanup_status: 'failed',
    cleanup_error: 'storage_unavailable',
  }
  status.active_job_id = 'published'
  status.results = [{ id: 'published', status: 'succeeded', generation: 1 }]
  show({ ...capture, audio_retention: retention() })
  await screen.findByText('Confirmed original')
  expect(screen.getByText('retention.failed')).toBeInTheDocument()
  expect(screen.getByText('retention.noPlayback')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'asr.source' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'asr.retry' })).toBeDisabled()
})

it('fails closed when text retention metadata is missing', async () => {
  show({ ...capture, audio_retention: retention() })
  await screen.findByText('retention.unavailable')
  expect(screen.getByRole('button', { name: 'asr.start' })).toBeDisabled()
})

it('keeps an uncertain request recoverable after the text retry deadline', async () => {
  status.audio_retention = {
    ...retention(),
    retry_until: new Date(Date.now() - 1000).toISOString(),
  }
  const pending = {
    key: 'original-key',
    expected_job_id: null,
    allow_incomplete: false,
  }
  sessionStorage.setItem('capture-asr:owner:capture', JSON.stringify(pending))
  show({ ...capture, audio_retention: retention() })
  fireEvent.click(await screen.findByRole('button', { name: 'asr.recover' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0][1]!.headers).toEqual({ 'Idempotency-Key': pending.key })
  expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({
    expected_job_id: null,
    allow_incomplete: false,
  })
})

it.each([401, 403, 404, 408, 429, 503])(
  'keeps the original ASR intent after uncertain HTTP %s',
  async (code) => {
    const baseline = vi.mocked(fetchApi).getMockImplementation()!
    vi.mocked(fetchApi).mockImplementation(async (path, options, ...rest) => {
      if (options?.method === 'POST') throw new ApiError(code, {})
      return baseline(path, options, ...rest)
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'asr.start' }))
    await screen.findByText('asr.uncertain')
    const first = posts()[0][1]!
    fireEvent.click(screen.getByRole('button', { name: 'asr.recover' }))
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1][1]!.body).toBe(first.body)
    expect(posts()[1][1]!.headers).toEqual(first.headers)
    expect(sessionStorage.getItem('capture-asr:owner:capture')).not.toBeNull()
  }
)

// --- playback ↔ transcript coupling -----------------------------------------

/** Two contiguous originals so a position can fall inside exactly one of them. */
const twoRows = () => {
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return { job: { id: 'job' } }
    if (path.includes('original-segments'))
      return {
        results: [
          { id: 'first', start_ms: 0, end_ms: 1000, text: 'First line' },
          { id: 'second', start_ms: 1000, end_ms: 2000, text: 'Second line' },
        ],
        next_cursor: null,
      }
    return status
  })
}

function showWithPosition(positionMs: number) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CaptureTranscriptionPanel
        viewerId="owner"
        capture={capture}
        onSource={onSource}
        positionMs={positionMs}
        activeId={null}
        follow={{ suppressed: () => false, suppressionEpoch: 0 }}
      />
    </QueryClientProvider>
  )
}

it('marks the segment the playback position is inside', async () => {
  twoRows()
  status.active_job_id = 'job'
  showWithPosition(1200)
  const second = (await screen.findByText('Second line')).closest('article')!
  const first = screen.getByText('First line').closest('article')!
  // aria-current is the accessible twin of the visual highlight.
  expect(second).toHaveAttribute('aria-current', 'true')
  expect(first).not.toHaveAttribute('aria-current')
})

it('moves the highlight as the position advances', async () => {
  twoRows()
  status.active_job_id = 'job'
  const view = showWithPosition(100)
  const first = (await screen.findByText('First line')).closest('article')!
  expect(first).toHaveAttribute('aria-current', 'true')

  view.rerender(
    <QueryClientProvider client={client}>
      <CaptureTranscriptionPanel
        viewerId="owner"
        capture={capture}
        onSource={onSource}
        positionMs={1500}
      />
    </QueryClientProvider>
  )
  expect(screen.getByText('Second line').closest('article')!).toHaveAttribute(
    'aria-current',
    'true'
  )
  expect(
    screen.getByText('First line').closest('article')!
  ).not.toHaveAttribute('aria-current')
})

it('highlights nothing in a recording gap instead of pointing at a neighbour', async () => {
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return { job: { id: 'job' } }
    if (path.includes('original-segments'))
      return {
        results: [
          { id: 'a', start_ms: 0, end_ms: 1000, text: 'Before the gap' },
          { id: 'b', start_ms: 3000, end_ms: 4000, text: 'After the gap' },
        ],
        next_cursor: null,
      }
    return status
  })
  status.active_job_id = 'job'
  showWithPosition(2000)
  await screen.findByText('Before the gap')
  expect(
    screen.queryByRole('article', { current: 'true' })
  ).not.toBeInTheDocument()
})

it('keeps every row highlight-free when nothing is playing', async () => {
  twoRows()
  status.active_job_id = 'job'
  // No position prop at all: the panel is usable without a player.
  show()
  await screen.findByText('First line')
  expect(
    document.querySelectorAll('article[aria-current="true"]')
  ).toHaveLength(0)
})

it('lets a click on a timestamp still seek, now that rows also follow playback', async () => {
  twoRows()
  status.active_job_id = 'job'
  showWithPosition(100)
  const row = (await screen.findByText('Second line')).closest('article')!
  fireEvent.click(within(row).getByRole('button', { name: /asr\.source/ }))
  // One direction is unchanged: clicking text still moves the audio.
  expect(onSource).toHaveBeenCalledWith(1000)
})

it('fetches the playback window beyond page one and can seek back', async () => {
  status.active_job_id = 'job'
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (!path.includes('original-segments')) return status
    const at = Number(new URLSearchParams(path.split('?')[1]).get('at_ms'))
    return at >= 60000
      ? {
          results: [
            {
              id: 'late',
              start_ms: 60000,
              end_ms: 62000,
              text: 'Later minute',
            },
          ],
          next_cursor: null,
        }
      : {
          results: [
            { id: 'early', start_ms: 0, end_ms: 1000, text: 'Opening' },
          ],
          next_cursor: 'next',
        }
  })
  const view = showWithPosition(61000)
  expect(
    (await screen.findByText('Later minute')).closest('article')
  ).toHaveAttribute('aria-current', 'true')
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([path]) => path.includes('at_ms=61000'))
  ).toBe(true)
  view.rerender(
    <QueryClientProvider client={client}>
      <CaptureTranscriptionPanel
        viewerId="owner"
        capture={capture}
        positionMs={100}
        onSource={onSource}
      />
    </QueryClientProvider>
  )
  expect(
    (await screen.findByText('Opening')).closest('article')
  ).toHaveAttribute('aria-current', 'true')
})
