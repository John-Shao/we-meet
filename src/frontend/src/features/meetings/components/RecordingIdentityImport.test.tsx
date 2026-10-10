import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { uploadFetch } from '@/api/uploadFetch'
import {
  clearTokens,
  getAuthSnapshot,
  setTokens,
} from '@/features/auth/utils/tokenStorage'
import {
  ImportIdentityClient,
  boundImportRequest,
} from '@/features/voiceprint/importIdentity'
import {
  OWNER,
  ORG,
  RECORD,
  KEY,
} from '@/features/voiceprint/identificationFixtures.test-utils'
import { CHUNKED_THRESHOLD } from '../chunkedUpload'
import { RecordingUpload, UploadedRecordingStatus } from './RecordingUpload'

const navigate = vi.fn()
const { uploadInParts } = vi.hoisted(() => ({ uploadInParts: vi.fn() }))
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: vi.fn(),
}))
vi.mock('@/api/uploadFetch', () => ({ uploadFetch: vi.fn() }))
vi.mock('wouter', () => ({ useLocation: () => ['', navigate] }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../chunkedUpload', async (original) => ({
  ...(await original<typeof import('../chunkedUpload')>()),
  uploadInParts,
  putPartWithProgress: vi.fn(),
}))

let cache: QueryClient
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  setTokens({ accessToken: 'synthetic-login' })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => cache.clear())
const show = (children: React.ReactNode) =>
  render(<QueryClientProvider client={cache}>{children}</QueryClientProvider>)
const declarations: unknown[] = []

function configure(path: 'legacy' | 'direct' | 'chunked' = 'legacy') {
  declarations.length = 0
  vi.mocked(fetchApi).mockImplementation(async (url, options) => {
    if (url === 'recording-uploads/' && options?.method !== 'POST')
      return {
        available: true,
        max_bytes: 1024,
        extensions: ['wav'],
        direct_upload_available: path !== 'legacy',
        direct_max_bytes: 512 * 1024 * 1024,
        identity_preflight: {
          available: true,
          max_bytes: 512 * 1024 * 1024,
          max_candidates: 2,
        },
      }
    if (url.startsWith('voiceprint/scopes/'))
      return {
        results: [
          {
            id: ORG,
            name: 'Organization',
            can_manage_policy: false,
            policy: { enabled: true, version: 1 },
          },
        ],
        next_offset: null,
      }
    if (url.startsWith('recording-uploads/identity-candidates/')) {
      const query = new URLSearchParams(url.split('?')[1])
      return {
        organization_id:
          query.get('organization_id') === 'personal' ? null : ORG,
        results:
          query.get('organization_id') === 'personal'
            ? [{ id: OWNER, name: 'Self' }]
            : [{ id: KEY, name: 'Colleague' }],
        next_offset: null,
      }
    }
    if (url === 'recording-uploads/upload-url/') {
      declarations.push(JSON.parse(options!.body as string))
      return {
        upload_url: 'https://invalid.test/signed',
        storage_name: 'private-key',
        headers: { 'Content-Type': 'audio/wav' },
      }
    }
    if (
      url === 'recording-uploads/upload-complete/' ||
      (url === 'recording-uploads/' && options?.method === 'POST')
    ) {
      declarations.push(
        options!.body instanceof FormData
          ? JSON.parse(options!.body.get('identity') as string)
          : JSON.parse(options!.body as string)
      )
      return {
        record_id: RECORD,
        status: 'queued',
        attempt: 1,
        retryable: false,
      }
    }
    throw new Error('Unexpected local fixture request: ' + url)
  })
  vi.mocked(uploadFetch).mockResolvedValue({ ok: true } as Response)
  uploadInParts.mockResolvedValue({ record_id: RECORD, status: 'queued' })
}

async function select(path: 'legacy' | 'direct' | 'chunked' = 'legacy') {
  show(<RecordingUpload viewerId={OWNER} />)
  await screen.findByRole('button', { name: 'upload.open' })
  const file = new File(['synthetic'], 'meeting.wav', { type: 'audio/wav' })
  if (path !== 'legacy')
    Object.defineProperty(file, 'size', {
      value: path === 'chunked' ? CHUNKED_THRESHOLD + 1 : 4096,
    })
  fireEvent.change(screen.getByLabelText('upload.file'), {
    target: { files: [file] },
  })
  fireEvent.click(screen.getByLabelText('upload.identity'))
  expect(screen.getByLabelText('upload.diarization')).toBeChecked()
  expect(screen.queryByText('upload.error')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'upload.submit', hidden: true })
  ).toBeDisabled()
  fireEvent.click(await screen.findByLabelText('Self'))
}
const submit = () =>
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'upload.submit', hidden: true })
      .closest('form')!
  )

it.each(['legacy', 'direct', 'chunked'] as const)(
  'carries one explicit scope and candidate declaration through %s',
  async (path) => {
    configure(path)
    await select(path)
    submit()
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        `/meeting/records/${RECORD}?tab=text`
      )
    )
    const intent = { organization_id: null, candidate_user_ids: [OWNER] }
    if (path === 'legacy') expect(declarations).toEqual([intent])
    else if (path === 'direct') {
      expect(declarations).toHaveLength(2)
      expect(declarations[0]).toMatchObject({
        identity: intent,
        diarization: true,
      })
      expect(declarations[1]).toMatchObject({
        identity: intent,
        diarization: true,
      })
    } else {
      expect(uploadInParts.mock.calls[0][2]).toMatchObject({
        identity: intent,
        diarization: true,
      })
      const request = uploadInParts.mock.calls[0][3].request
      clearTokens()
      const count = vi.mocked(fetchApi).mock.calls.length
      await expect(
        request('recording-uploads/multipart/begin/', { method: 'POST' })
      ).rejects.toThrow('authentication_changed')
      expect(vi.mocked(fetchApi).mock.calls.length).toBe(count)
    }
    const privateWrite = vi
      .mocked(fetchApi)
      .mock.calls.find(([, options]) => options?.method === 'POST')
    if (privateWrite)
      expect(
        new Headers(privateWrite[1]!.headers).get('X-Voiceprint-Owner')
      ).toBe(OWNER)
  }
)

it('clears personal selections when switching libraries and disables identity if diarization is turned off', async () => {
  configure()
  await select()
  fireEvent.change(screen.getByLabelText('scope'), { target: { value: ORG } })
  expect(
    screen.getByRole('button', { name: 'upload.submit', hidden: true })
  ).toBeDisabled()
  expect(screen.queryByLabelText('Self')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByLabelText('Colleague'))
  fireEvent.click(screen.getByLabelText('upload.diarization'))
  expect(screen.getByLabelText('upload.identity')).not.toBeChecked()
  expect(screen.queryByLabelText('scope')).not.toBeInTheDocument()
  submit()
  await waitFor(() => expect(navigate).toHaveBeenCalled())
  const write = vi
    .mocked(fetchApi)
    .mock.calls.find(([, value]) => value?.method === 'POST')!
  expect((write[1]!.body as FormData).get('identity')).toBeNull()
})

it.each([false, true])(
  'keeps identity intent and stored bytes fixed on a completion retry (capability disabled: %s)',
  async (disabled) => {
    configure('direct')
    const original = vi.mocked(fetchApi).getMockImplementation()!
    let completions = 0
    vi.mocked(fetchApi).mockImplementation(async (path, value) => {
      if (path === 'recording-uploads/upload-complete/' && completions++ === 0)
        throw new Error('Uncertain adoption')
      const result = await original(path, value)
      if (
        disabled &&
        completions > 0 &&
        path === 'recording-uploads/' &&
        value?.method !== 'POST'
      )
        return {
          ...(result as object),
          identity_preflight: { available: false, max_candidates: 0 },
        }
      return result
    })
    await select('direct')
    submit()
    await screen.findByRole('alert')
    expect(screen.getByLabelText('scope')).toBeDisabled()
    expect(screen.getByLabelText('upload.identity')).toBeDisabled()
    if (disabled) {
      await act(async () => {
        await cache.invalidateQueries({
          queryKey: ['recording-upload-capabilities'],
        })
      })
      await screen.findByText('upload.identityUnavailable')
    }
    expect(
      screen.getByRole('button', { name: 'upload.submit', hidden: true })
    ).toBeEnabled()
    submit()
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(uploadFetch).toHaveBeenCalledTimes(1)
    const attempts = vi
      .mocked(fetchApi)
      .mock.calls.filter(
        ([path]) => path === 'recording-uploads/upload-complete/'
      )
      .map(([, options]) => options!.body)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBe(attempts[1])
  }
)

it('blocks a fresh import when candidate refresh fails, while preserving the explicit selection', async () => {
  configure()
  await select()
  const original = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (path.startsWith('recording-uploads/identity-candidates/'))
      throw new Error('Unavailable directory')
    return original(path, options)
  })
  fireEvent.change(screen.getByLabelText('search'), {
    target: { value: 'New search' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'searchAction' }))
  await screen.findByText('directoryError')
  expect(
    screen.getByRole('button', { name: 'upload.submit', hidden: true })
  ).toBeDisabled()
  submit()
  expect(declarations).toHaveLength(0)
  expect(navigate).not.toHaveBeenCalled()
})

it('allows turning off a selected identity option after capability becomes unavailable', async () => {
  configure()
  await select()
  const original = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    const result = await original(path, options)
    if (path === 'recording-uploads/' && options?.method !== 'POST')
      return {
        ...(result as object),
        identity_preflight: { available: false, max_candidates: 0 },
      }
    return result
  })
  await act(async () => {
    await cache.invalidateQueries({
      queryKey: ['recording-upload-capabilities'],
    })
  })
  await screen.findByText('upload.identityUnavailable')
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'upload.submit', hidden: true })
    ).toBeDisabled()
  )
  expect(screen.getByLabelText('upload.identity')).toBeEnabled()
  fireEvent.click(screen.getByLabelText('upload.identity'))
  expect(
    screen.getByRole('button', { name: 'upload.submit', hidden: true })
  ).toBeEnabled()
  submit()
  await waitFor(() => expect(navigate).toHaveBeenCalled())
  const write = vi
    .mocked(fetchApi)
    .mock.calls.find(([, options]) => options?.method === 'POST')!
  expect((write[1]!.body as FormData).get('identity')).toBeNull()
})

it('aborts a pending extra scope page when identity selection is closed', async () => {
  configure()
  const original = vi.mocked(fetchApi).getMockImplementation()!
  let signal: AbortSignal | undefined
  let resolve!: (value: unknown) => void
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (path.startsWith('voiceprint/scopes/')) {
      if (path.includes('offset=25')) {
        signal = options?.signal ?? undefined
        return new Promise((done) => {
          resolve = done
        })
      }
      return { ...((await original(path, options)) as object), next_offset: 25 }
    }
    return original(path, options)
  })
  await select()
  fireEvent.click(await screen.findByRole('button', { name: 'moreScopes' }))
  await waitFor(() => expect(signal).toBeDefined())
  fireEvent.click(screen.getByLabelText('upload.identity'))
  expect(signal!.aborted).toBe(true)
  await act(async () => resolve({ results: [], next_offset: null }))
  expect(screen.queryByLabelText('scope')).not.toBeInTheDocument()
})

it('rejects a candidate page returned for a different organization', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    organization_id: null,
    results: [{ id: OWNER, name: 'Self' }],
    next_offset: null,
  })
  await expect(new ImportIdentityClient(OWNER).candidates(ORG)).rejects.toThrow(
    'voiceprint_response_invalid'
  )
})

it('discards a late signed ticket after logout without uploading or navigating', async () => {
  configure('direct')
  let finish!: (value: unknown) => void
  const original = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation((path, value) =>
    path === 'recording-uploads/upload-url/'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : original(path, value)
  )
  await select('direct')
  submit()
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await act(async () => {
    clearTokens()
    window.dispatchEvent(new Event('storage'))
    finish({
      upload_url: 'https://invalid.test/old',
      storage_name: 'old-private-key',
      headers: {},
    })
  })
  expect(uploadFetch).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Self')).not.toBeInTheDocument()
})

it.each(['retry_identity', 'continue_without_identity'] as const)(
  'requires explicit %s after failed preflight without re-uploading',
  async (action) => {
    let decided = false
    vi.mocked(fetchApi).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        decided = true
        return {}
      }
      return {
        record_id: RECORD,
        status: decided ? 'queued' : 'failed',
        attempt: decided ? 2 : 1,
        retryable: false,
        identity_preflight: {
          status: decided
            ? action === 'retry_identity'
              ? 'pending'
              : 'disabled'
            : 'awaiting_choice',
          reason: 'media_probe_invalid',
          can_continue_without_identity: !decided,
        },
      }
    })
    show(<UploadedRecordingStatus viewerId={OWNER} recordId={RECORD} />)
    expect(
      await screen.findByText('upload.preflightFailed')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'upload.retry' })
    ).not.toBeInTheDocument()
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.some(([, options]) => options?.method === 'POST')
    ).toBe(false)
    fireEvent.click(
      screen.getByRole('button', { name: `upload.preflightDecision.${action}` })
    )
    await screen.findByText('upload.status.queued')
    if (action === 'continue_without_identity')
      expect(
        screen.queryByText('upload.preflightPending')
      ).not.toBeInTheDocument()
    const write = vi
      .mocked(fetchApi)
      .mock.calls.find(([, value]) => value?.method === 'POST')!
    expect(write[0]).toBe(`recording-uploads/${RECORD}/identity-preflight/`)
    expect(JSON.parse(write[1]!.body as string)).toEqual({
      expected_attempt: 1,
      action,
    })
    expect(new Headers(write[1]!.headers).get('X-Voiceprint-Owner')).toBe(OWNER)
    expect(uploadFetch).not.toHaveBeenCalled()
  }
)

it('shows independent identity unavailability while keeping completed transcription', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    record_id: RECORD,
    status: 'succeeded',
    attempt: 1,
    retryable: false,
    identity_request: {
      status: 'unavailable',
      reason: 'identity_dispatch_unavailable',
    },
  })
  show(<UploadedRecordingStatus viewerId={OWNER} recordId={RECORD} />)
  expect(
    await screen.findByText('upload.identityRequest.unavailable')
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'upload.retry' })
  ).not.toBeInTheDocument()
})

it('rejects a personal candidate response that contains another account', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    organization_id: null,
    results: [{ id: KEY, name: 'Other' }],
    next_offset: null,
  })
  await expect(
    new ImportIdentityClient(OWNER).candidates(null)
  ).rejects.toThrow('voiceprint_response_invalid')
})

it('fences a late app response and every subsequent request across login changes', async () => {
  const request = boundImportRequest(OWNER, getAuthSnapshot(), true)
  let done!: (value: unknown) => void
  vi.mocked(fetchApi).mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve
      })
  )
  const pending = request('recording-uploads/upload-complete/', {
    method: 'POST',
  })
  setTokens({ accessToken: 'different-login' })
  done({ record_id: RECORD })
  await expect(pending).rejects.toThrow('authentication_changed')
  await expect(
    request('recording-uploads/upload-complete/', { method: 'POST' })
  ).rejects.toThrow('authentication_changed')
  expect(fetchApi).toHaveBeenCalledTimes(1)
})
