import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { uploadFetch } from '@/api/uploadFetch'
import { CHUNKED_THRESHOLD, UploadCancelled } from '../chunkedUpload'
import { RecordingUpload, UploadedRecordingStatus } from './RecordingUpload'

const navigate = vi.fn()
// Hoisted: the factory below runs before this module's body, so the mock has to
// be created first.
const { uploadInParts } = vi.hoisted(() => ({ uploadInParts: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/api/uploadFetch', () => ({ uploadFetch: vi.fn() }))
vi.mock('wouter', () => ({ useLocation: () => ['', navigate] }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
// The chunked loop is unit-tested on its own; here only the component's reaction
// to it matters, and the real one needs XMLHttpRequest (absent in jsdom).
vi.mock('../chunkedUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../chunkedUpload')>()),
  uploadInParts,
  putPartWithProgress: vi.fn(),
}))
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `resetAllMocks` in afterEach clears calls but leaves a queued
  // `mockRejectedValueOnce`/`mockImplementationOnce` to be consumed by whatever
  // runs next. The chunked mock is file-scoped, so it has to be cleared here or a
  // test only passes in isolation.
  uploadInParts.mockReset()
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

it('opens the picker directly, confirms video metadata and opens the native history destination', async () => {
  const onRecord = vi.fn()
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      available: true,
      max_bytes: 1024,
      extensions: ['wav', 'mp4', 'mov'],
    })
    .mockResolvedValueOnce({ record_id: 'video-id', status: 'queued' })
  show(<RecordingUpload viewerId="owner" onRecord={onRecord} />)
  const trigger = await screen.findByRole('button', { name: 'upload.open' })
  const input = screen.getByLabelText('upload.file') as HTMLInputElement
  expect(input.accept).toBe('.wav,.mp4,.mov')
  const click = vi.spyOn(input, 'click')
  fireEvent.click(trigger)
  expect(click).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.change(input, { target: { files: [] } })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  const video = new File(['video'], 'Demo.MOV', { type: 'video/quicktime' })
  fireEvent.change(input, { target: { files: [video] } })
  expect(await screen.findByText('Demo.MOV')).toBeInTheDocument()
  expect(screen.getByText('upload.videoHint')).toBeInTheDocument()
  expect(fetchApi).toHaveBeenCalledTimes(1)
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'upload.submit', hidden: true })
      .closest('form')!
  )
  await waitFor(() => expect(onRecord).toHaveBeenCalledWith('video-id'))
  expect(navigate).not.toHaveBeenCalled()
  click.mockRestore()
})
it('preserves the upload intent when a failed request is retried', async () => {
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      available: true,
      max_bytes: 1024,
      extensions: ['wav'],
    })
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValueOnce({ record_id: 'record', status: 'queued' })
  show(<RecordingUpload viewerId="owner" />)
  const input = await screen.findByLabelText('upload.file')
  fireEvent.change(input, {
    target: { files: [new File(['audio'], 'Demo.wav')] },
  })
  const form = screen
    .getByRole('button', { name: 'upload.submit', hidden: true })
    .closest('form')!
  fireEvent.submit(form)
  await screen.findByRole('alert')
  fireEvent.submit(form)
  await waitFor(() => expect(navigate).toHaveBeenCalled())
  const bodies = vi
    .mocked(fetchApi)
    .mock.calls.slice(1)
    .map(([, options]) => options!.body as FormData)
  expect(bodies[1].get('key')).toEqual(bodies[0].get('key'))
})

/** The direct path is the only one that can carry more than the multipart limit. */
const withDirect = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  max_bytes: 100,
  direct_upload_available: true,
  direct_max_bytes: 4 * CHUNKED_THRESHOLD,
  extensions: ['wav'],
  ...overrides,
})

/** Selects a file and submits the dialog, returning the form for a retry. */
async function pick(name = 'Long.wav', bytes = 4096) {
  const input = await screen.findByLabelText('upload.file')
  fireEvent.change(input, {
    target: { files: [new File(['x'.repeat(bytes)], name)] },
  })
  const form = screen
    .getByRole('button', { name: 'upload.submit', hidden: true })
    .closest('form')!
  fireEvent.submit(form)
  return form
}

it('sends a file over the multipart limit straight to storage, then adopts it', async () => {
  const storage = vi.fn().mockResolvedValue({ ok: true })
  vi.mocked(uploadFetch).mockImplementation(storage)
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://bucket.example/put?sig=abc',
      storage_name: 'record-uploads/abc.wav',
      headers: { 'Content-Type': 'audio/wav', 'x-amz-acl': 'private' },
    })
    .mockResolvedValueOnce({ record_id: 'big', status: 'queued' })
  try {
    show(<RecordingUpload viewerId="owner" />)
    await pick()
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/meeting/records/big?tab=text')
    )

    // Bytes go to storage, addressed by the signed URL the server handed out.
    expect(storage).toHaveBeenCalledOnce()
    const [url, init] = storage.mock.calls[0]
    expect(url).toBe('https://bucket.example/put?sig=abc')
    expect((init as RequestInit).method).toBe('PUT')
    expect((init as RequestInit).headers).toEqual({
      'Content-Type': 'audio/wav',
      'x-amz-acl': 'private',
    })

    // Adoption is a second call carrying the declaration plus the storage key.
    const complete = vi.mocked(fetchApi).mock.calls.at(-1)!
    expect(complete[0]).toBe('recording-uploads/upload-complete/')
    const body = JSON.parse((complete[1] as RequestInit).body as string)
    expect(body.storage_name).toBe('record-uploads/abc.wav')
    expect(body.size).toBe(4096)
    expect(body.name).toBe('Long.wav')
    // No multipart body anywhere: that branch cannot carry this file.
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([, o]) => o?.body instanceof FormData)
    ).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('does not send app credentials to the storage host', async () => {
  // The signed URL carries its own authorization; replaying our session cookie
  // to a third-party origin would leak it, so the PUT is deliberately bare
  // except for the Content-Type the signature covers.
  const storage = vi.fn().mockResolvedValue({ ok: true })
  vi.mocked(uploadFetch).mockImplementation(storage)
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://bucket.example/put?sig=abc',
      storage_name: 'record-uploads/abc.wav',
      headers: { 'Content-Type': 'audio/wav' },
    })
    .mockResolvedValueOnce({ record_id: 'big', status: 'queued' })
  try {
    show(<RecordingUpload viewerId="owner" />)
    await pick()
    await waitFor(() => expect(storage).toHaveBeenCalled())
    const init = storage.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual({ 'Content-Type': 'audio/wav' })
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps the storage ticket when only the final adoption failed', async () => {
  // The ticket is a signed PUT for one exact object, so a retry must reuse it
  // rather than ask the server to sign a second key — otherwise the first
  // object is orphaned in the bucket.
  const storage = vi.fn().mockResolvedValue({ ok: true })
  vi.mocked(uploadFetch).mockImplementation(storage)
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://bucket.example/put?sig=abc',
      storage_name: 'record-uploads/abc.wav',
      headers: { 'Content-Type': 'audio/wav' },
    })
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValueOnce({ record_id: 'big', status: 'queued' })
  try {
    show(<RecordingUpload viewerId="owner" />)
    const form = await pick()
    await screen.findByRole('alert')
    fireEvent.submit(form)
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.filter(([url]) => url === 'recording-uploads/upload-url/')
    ).toHaveLength(1)
    // Completion retries also work after the PUT signature has expired.
    // Successfully transferred bytes are not uploaded again.
    expect(storage).toHaveBeenCalledTimes(1)
    expect(new Set(storage.mock.calls.map(([url]) => url))).toEqual(
      new Set(['https://bucket.example/put?sig=abc'])
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('reuses one idempotency key across a retried completion', async () => {
  const storage = vi.fn().mockResolvedValue({ ok: true })
  vi.mocked(uploadFetch).mockImplementation(storage)
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://bucket.example/put?sig=abc',
      storage_name: 'record-uploads/abc.wav',
      headers: { 'Content-Type': 'audio/wav' },
    })
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValueOnce({ record_id: 'big', status: 'queued' })
  try {
    show(<RecordingUpload viewerId="owner" />)
    const form = await pick()
    await screen.findByRole('alert')
    fireEvent.submit(form)
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    const keys = vi
      .mocked(fetchApi)
      .mock.calls.filter(
        ([url]) => url === 'recording-uploads/upload-complete/'
      )
      .map(([, o]) => JSON.parse((o as RequestInit).body as string).key)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toEqual(keys[0])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('still uses the multipart branch when the server does not offer direct uploads', async () => {
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      available: true,
      max_bytes: 1024,
      // The older server's capability payload: no direct fields at all.
      extensions: ['wav'],
    })
    .mockResolvedValueOnce({ record_id: 'small', status: 'queued' })
  show(<RecordingUpload viewerId="owner" />)
  await pick('Small.wav', 64)
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('/meeting/records/small?tab=text')
  )
  const call = vi.mocked(fetchApi).mock.calls.at(-1)!
  expect(call[0]).toBe('recording-uploads/')
  expect((call[1] as RequestInit).body).toBeInstanceOf(FormData)
})

it('refuses a file above the direct ceiling before opening a ticket', async () => {
  vi.mocked(fetchApi).mockResolvedValueOnce(
    withDirect({ direct_max_bytes: 2048 })
  )
  show(<RecordingUpload viewerId="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.open' }))
  await pick('TooBig.wav', 4096)
  expect(await screen.findByRole('alert')).toHaveTextContent('upload.error')
  // Only the capability read happened: nothing was signed and nothing was sent.
  expect(fetchApi).toHaveBeenCalledTimes(1)
})

/** A file above the threshold, so the chunked path is the one taken. */
const chunkedCapabilities = {
  available: true,
  max_bytes: 100,
  direct_upload_available: true,
  direct_max_bytes: 4 * CHUNKED_THRESHOLD,
  extensions: ['wav'],
}

it('reports a cancelled transfer as cancelled, not as an error', async () => {
  // A stop is not an ambiguous outcome. Showing the generic failure here would
  // tell the reader something went wrong when they are the one who stopped it.
  uploadInParts.mockRejectedValueOnce(new UploadCancelled())
  vi.mocked(fetchApi).mockResolvedValueOnce(chunkedCapabilities)
  show(<RecordingUpload viewerId="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.open' }))
  await pick('Long.wav', CHUNKED_THRESHOLD + 1)
  await screen.findByText('upload.cancelled')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  // Nothing navigated: the reader stays where they were, free to retry.
  expect(navigate).not.toHaveBeenCalled()
})

it('shows byte progress and offers a way out while a large transfer runs', async () => {
  let report: ((sent: number, total: number) => void) | undefined
  uploadInParts.mockImplementationOnce(
    (
      _file,
      _intent,
      _declaration,
      _deps,
      _signal,
      onProgress: (s: number, t: number) => void
    ) => {
      report = onProgress
      // Never settles, so the mid-transfer state can be inspected.
      return new Promise(() => {})
    }
  )
  vi.mocked(fetchApi).mockResolvedValueOnce(chunkedCapabilities)
  show(<RecordingUpload viewerId="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: 'upload.open' }))
  await pick('Long.wav', CHUNKED_THRESHOLD + 1)
  await waitFor(() => expect(report).toBeDefined())
  expect(
    screen.getByRole('button', { name: 'upload.cancel' })
  ).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
})

it('stops a normal upload and retains its declaration for an uncertain retry', async () => {
  let options: NonNullable<Parameters<typeof fetchApi>[1]> | undefined
  vi.mocked(fetchApi)
    .mockResolvedValueOnce({
      available: true,
      max_bytes: 8192,
      extensions: ['wav'],
    })
    .mockImplementationOnce((_path, init) => {
      options = init
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () =>
          reject(init!.signal!.reason)
        )
      )
    })
    .mockResolvedValueOnce({ record_id: 'accepted', status: 'queued' })
  show(<RecordingUpload viewerId="owner" />)
  const form = await pick()
  act(() => options!.onUploadProgress!(2048, 4096))
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '2048')
  fireEvent.click(screen.getByRole('button', { name: 'upload.cancel' }))
  await screen.findByText('upload.stopped')
  expect(options!.signal!.aborted).toBe(true)
  expect(screen.queryByText('upload.cancelled')).not.toBeInTheDocument()
  expect(screen.getByLabelText('upload.context')).toBeDisabled()
  expect(navigate).not.toHaveBeenCalled()
  fireEvent.submit(form)
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('/meeting/records/accepted?tab=text')
  )
  const retried = vi.mocked(fetchApi).mock.calls.at(-1)![1]!.body as FormData
  expect(retried.get('key')).toBe((options!.body as FormData).get('key'))
})

it('cancels a direct PUT before adoption and reports its progress', async () => {
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://storage.example/put',
      storage_name: 'object',
      headers: {},
    })
  vi.mocked(uploadFetch).mockImplementation((_url, options, report) => {
    report(2048, 4096)
    return new Promise((_resolve, reject) =>
      options.signal!.addEventListener('abort', () =>
        reject(options.signal!.reason)
      )
    )
  })
  show(<RecordingUpload viewerId="owner" />)
  await pick()
  await waitFor(() =>
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '2048')
  )
  fireEvent.click(screen.getByRole('button', { name: 'upload.cancel' }))
  await screen.findByText('upload.stopped')
  expect(fetchApi).toHaveBeenCalledTimes(2)
  expect(navigate).not.toHaveBeenCalled()
})

it('retries a stopped completion without uploading the stored bytes again', async () => {
  vi.mocked(uploadFetch).mockResolvedValue({ ok: true } as Response)
  vi.mocked(fetchApi)
    .mockResolvedValueOnce(withDirect())
    .mockResolvedValueOnce({
      upload_url: 'https://storage.example/put',
      storage_name: 'object',
      headers: {},
    })
    .mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(options!.signal!.reason)
          )
        })
    )
    .mockResolvedValueOnce({ record_id: 'accepted', status: 'queued' })
  show(<RecordingUpload viewerId="owner" />)
  const form = await pick()
  await screen.findByText('upload.confirming')
  fireEvent.click(screen.getByRole('button', { name: 'upload.cancel' }))
  await screen.findByText('upload.stopped')
  fireEvent.submit(form)
  await waitFor(() => expect(navigate).toHaveBeenCalled())
  expect(uploadFetch).toHaveBeenCalledOnce()
  const completions = vi
    .mocked(fetchApi)
    .mock.calls.filter(([path]) => path.endsWith('upload-complete/'))
  expect(completions[0][1]!.body).toEqual(completions[1][1]!.body)
})
