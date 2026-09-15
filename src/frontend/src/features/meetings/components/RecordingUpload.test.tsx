import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { RecordingUpload, UploadedRecordingStatus } from './RecordingUpload'

const navigate = vi.fn()
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('wouter', () => ({ useLocation: () => ['', navigate] }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  client.clear()
  vi.resetAllMocks()
})
const show = (element: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)

it('uploads the chosen file and optional context without putting credentials in the browser', async () => {
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      available: true,
      max_bytes: 100,
      extensions: ['wav'],
    })
    .mockResolvedValueOnce({ record_id: 'record', status: 'queued' })
  show(<RecordingUpload viewerId="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.open' }))
  const file = new File(['audio'], 'record.wav', { type: 'audio/wav' })
  fireEvent.change(await screen.findByLabelText('upload.file'), {
    target: { files: [file] },
  })
  fireEvent.change(screen.getByLabelText('upload.context'), {
    target: { value: 'Project context' },
  })
  fireEvent.change(screen.getByLabelText('upload.hotwords'), {
    target: { value: 'Qwen' },
  })
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'upload.submit', hidden: true })
      .closest('form')!
  )
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('/meeting/records/record?tab=text')
  )
  const request = vi.mocked(fetchApi).mock.calls[1][1]!
  expect(request.method).toBe('POST')
  const body = request.body as FormData
  expect(body.get('audio')).toBe(file)
  expect(body.get('context')).toBe('Project context')
  expect(body.get('hotwords')).toBe('Qwen')
  expect(body.get('key')).toBeTruthy()
})

it('rejects an oversized file before sending it', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    available: true,
    max_bytes: 2,
    extensions: ['wav'],
  })
  show(<RecordingUpload viewerId="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.open' }))
  fireEvent.change(await screen.findByLabelText('upload.file'), {
    target: { files: [new File(['large'], 'record.wav')] },
  })
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'upload.submit', hidden: true })
      .closest('form')!
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('upload.error')
  expect(fetchApi).toHaveBeenCalledTimes(1)
})

it('hides upload when unavailable', async () => {
  vi.mocked(fetchApi).mockResolvedValue({ available: false })
  show(<RecordingUpload viewerId="owner" />)
  await waitFor(() => expect(fetchApi).toHaveBeenCalled())
  expect(screen.queryByText('upload.title')).not.toBeInTheDocument()
})

it('retries only the failed attempt shown to the user', async () => {
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      record_id: 'record',
      status: 'failed',
      attempt: 2,
      retryable: true,
      error_code: 'submission_unknown',
    })
    .mockResolvedValue({
      record_id: 'record',
      status: 'running',
      attempt: 3,
      retryable: false,
    })
  show(<UploadedRecordingStatus viewerId="owner" recordId="record" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.retry' }))
  await waitFor(() =>
    expect(fetchApi).toHaveBeenCalledWith('recording-uploads/record/', {
      method: 'POST',
      body: JSON.stringify({ attempt: 2 }),
    })
  )
  expect(await screen.findByText('upload.status.running')).toBeInTheDocument()
})
