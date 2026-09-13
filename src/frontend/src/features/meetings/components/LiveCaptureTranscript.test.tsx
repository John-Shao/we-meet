import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { LiveCaptureTranscript } from './LiveCaptureTranscript'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
let failed: boolean
function show(count = 65) {
  client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <LiveCaptureTranscript
        viewerId="owner"
        captureId="capture"
        jobId="live"
        lastSequence={count}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  failed = false
  vi.mocked(fetchApi).mockReset()
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (failed) throw new ApiError(403, {})
    const after = new URL(path, 'https://fixture.invalid').searchParams.get(
      'after_sequence'
    )
    return {
      job_id: 'live',
      status: 'running',
      published: false,
      last_sequence: 65,
      next_after_sequence: after === '0' ? 50 : null,
      results: [
        {
          id: 'segment',
          sequence: Number(after) + 1,
          text:
            after === '0' ? 'Older confirmed words' : 'Latest confirmed words',
          start_ms: 1050,
          end_ms: 2000,
          language: 'en',
        },
      ],
    }
  })
})
afterEach(() => client?.clear())

it('shows confirmed preview with original time without claiming a published transcript', async () => {
  show()
  await screen.findByText('Latest confirmed words')
  expect(screen.getByText('asr.previewHint')).toBeInTheDocument()
  expect(screen.getByText('0:01')).toBeInTheDocument()
  expect(vi.mocked(fetchApi).mock.calls[0][0]).toContain('after_sequence=15')
  expect(
    screen.queryByRole('button', { name: /play|source/i })
  ).not.toBeInTheDocument()
})

it('reads older pages and returns to the latest window without accumulating transcript text', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'previous' }))
  await screen.findByText('Older confirmed words')
  expect(screen.queryByText('Latest confirmed words')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'asr.followLatest' }))
  await screen.findByText('Latest confirmed words')
  expect(screen.queryByText('Older confirmed words')).not.toBeInTheDocument()
})

it('clears private preview text after permission revocation', async () => {
  show()
  await screen.findByText('Latest confirmed words')
  failed = true
  await act(() => client.invalidateQueries())
  await waitFor(() =>
    expect(screen.queryByText('Latest confirmed words')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('alert')).toHaveTextContent('asr.textError')
})

it('rejects a response from a different transcription attempt', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    job_id: 'other',
    results: [{ text: 'Wrong source' }],
  })
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('asr.textError')
  expect(screen.queryByText('Wrong source')).not.toBeInTheDocument()
})

it('labels retained partial text when a live attempt fails', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (...args) => ({
    ...((await baseline(...args)) as object),
    status: 'incomplete',
  }))
  show()
  expect(await screen.findByText('asr.partialPreview')).toBeInTheDocument()
})
