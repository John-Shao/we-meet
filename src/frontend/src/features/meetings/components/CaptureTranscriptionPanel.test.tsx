import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { ApiCaptureSession } from '../api/ApiCaptureSession'
import { CaptureTranscriptionPanel } from './CaptureTranscriptionPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('./RecordSummaryPanel', () => ({
  RecordSummaryPanel: ({
    onSourceAudio,
  }: {
    onSourceAudio: (time: number) => void
  }) => <button onClick={() => onSourceAudio(1200)}>summary-source</button>,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/primitives', () => ({
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
  available: boolean
  summary_available?: boolean
  active_job_id: string | null
  results: Array<{ id: string; status: string; generation: number }>
}
const capture = {
  id: 'capture',
  record_id: 'record',
  media_status: 'saved',
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
