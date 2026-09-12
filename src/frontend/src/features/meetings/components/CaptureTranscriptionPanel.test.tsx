import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import type { ApiCaptureSession } from '../api/ApiCaptureSession'
import { CaptureTranscriptionPanel } from './CaptureTranscriptionPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
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
        next: null,
      }
    return status
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
  sessionStorage.clear()
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
