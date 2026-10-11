import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { DiarizationClient } from '../capture/diarization'
import { OWNER, CAPTURE, job, state } from '../capture/diarization.test-utils'
import { CaptureDiarizationControls } from './CaptureDiarizationControls'
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
  }: {
    children: React.ReactNode
    isDisabled?: boolean
    onPress?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('@/primitives/Checkbox', () => ({
  Checkbox: ({
    children,
    isSelected,
    isDisabled,
    onChange,
  }: {
    children: React.ReactNode
    isSelected?: boolean
    isDisabled?: boolean
    onChange: (value: boolean) => void
  }) => (
    <label>
      <input
        type="checkbox"
        checked={isSelected}
        disabled={isDisabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  ),
}))
let cache: QueryClient
let current = state()
const published = vi.fn()
const posts = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
function show(editing = false) {
  return render(
    <QueryClientProvider client={cache}>
      <CaptureDiarizationControls
        viewerId={OWNER}
        captureId={CAPTURE}
        onPublished={published}
        editing={editing}
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  setTokens({ accessToken: 'synthetic' })
  current = state()
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(fetchApi).mockImplementation(async (_path, options) =>
    options?.method === 'POST'
      ? { job: job(), created: true }
      : structuredClone(current)
  )
})
afterEach(() => {
  cache.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  sessionStorage.clear()
})
async function accept() {
  const input = await screen.findByRole('checkbox')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.click(input)
}
it('requires explicit consent and never automatically posts a paid request', async () => {
  show()
  await screen.findByRole('checkbox')
  expect(
    screen.getByRole('button', { name: 'diarization.start' })
  ).toBeDisabled()
  expect(posts()).toHaveLength(0)
  await accept()
  fireEvent.click(screen.getByRole('button', { name: 'diarization.start' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  await waitFor(() =>
    expect(new DiarizationClient(OWNER, CAPTURE).intent()).toBeUndefined()
  )
})
it('replays the exact uncertain nonce and original revision only on request', async () => {
  vi.mocked(fetchApi).mockImplementation(async (_path, options) => {
    if (options?.method !== 'POST') return current
    if (posts().length === 1) throw new Error('network')
    return { job: job(), created: false }
  })
  show()
  await accept()
  fireEvent.click(screen.getByRole('button', { name: 'diarization.start' }))
  await screen.findByText('diarization.uncertain')
  expect(posts()).toHaveLength(1)
  current = { ...current, record_revision: 2 }
  fireEvent.click(screen.getByRole('button', { name: 'diarization.recover' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[0][1]?.body).toBe(posts()[1][1]?.body)
  expect(posts()[0][1]?.headers).toEqual(posts()[1][1]?.headers)
})
it('discards a definitive conflict and requires a fresh confirmation', async () => {
  vi.mocked(fetchApi).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') throw new ApiError(409, {})
    return current
  })
  show()
  await accept()
  fireEvent.click(screen.getByRole('button', { name: 'diarization.start' }))
  await screen.findByText('diarization.conflict')
  expect(new DiarizationClient(OWNER, CAPTURE).intent()).toBeUndefined()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})
it('cancels a running job even when paid creation is disabled', async () => {
  current = { ...current, available: false, can_start: false, results: [job()] }
  vi.mocked(fetchApi).mockImplementation(async (_path, options) =>
    options?.method === 'POST'
      ? { job: { ...job(), status: 'canceled' } }
      : current
  )
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'diarization.cancel' })
  )
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0][0]).toContain('/cancel/')
  expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({
    expected_revision: 1,
  })
})
it('hides previously read private history and blocks writes after a failed state check', async () => {
  current = { ...current, results: [job()] }
  show()
  await screen.findByText(/diarization.status.queued/, { selector: 'p' })
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(403, {}))
  fireEvent.click(screen.getByRole('button', { name: 'diarization.refresh' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('diarization.history')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'diarization.start' })
  ).toBeDisabled()
})
it('closes and clears intents immediately on account changes', async () => {
  const client = new DiarizationClient(OWNER, CAPTURE)
  client.remember({ key: crypto.randomUUID(), expected_revision: 1 })
  show()
  await screen.findByRole('button', { name: 'diarization.recover' })
  act(() => {
    setTokens({ accessToken: 'new-synthetic' })
    window.dispatchEvent(new Event('storage'))
  })
  await waitFor(() =>
    expect(screen.queryByText('diarization.title')).not.toBeInTheDocument()
  )
  expect(
    Object.keys(sessionStorage).filter((key) =>
      key.startsWith('capture-diarization:')
    )
  ).toHaveLength(0)
  expect(posts()).toHaveLength(0)
})
it('blocks new processing during unfinished text edits', async () => {
  show(true)
  await screen.findByRole('checkbox')
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'diarization.start' })
  ).toBeDisabled()
  expect(screen.getByText('diarization.editing')).toBeInTheDocument()
})
