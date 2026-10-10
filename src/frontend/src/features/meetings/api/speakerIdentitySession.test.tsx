import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  getAuthSnapshot,
  rotateTokens,
  setTokens,
} from '@/features/auth/utils/tokenStorage'
import {
  useSpeakerContacts,
  useSpeakerIdentityDecision,
} from './fetchMeetingRecord'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetchApi,
}))

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
const decision = {
  speakerId: 'speaker',
  decision: {
    action: 'set_label' as const,
    label: 'Guest',
    expected_revision: 3,
  },
}
const key = ['record-library-content', 'viewer', 3, 'originals']
const humanKeys = [
  ['human-summary', 'viewer', 'record'],
  [
    'human-summary-history',
    'viewer',
    'meeting-records/record/human-summary/history/',
  ],
  [
    'human-summary-history-detail',
    'viewer',
    'meeting-records/record/human-summary/history/',
    'old',
  ],
]

beforeEach(() => {
  vi.resetAllMocks()
  setTokens({
    accessToken: 'original-access-token-secret',
    refreshToken: 'original-refresh-token-secret',
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(key, { results: [] })
  humanKeys.forEach((key) => client.setQueryData(key, { frozen: true }))
  client.setQueryData(['human-summary', 'other-viewer', 'record'], {
    frozen: true,
  })
})
afterEach(() => client.clear())

it('refuses a decision opened in a previous login before sending it', async () => {
  const { result } = renderHook(
    () => useSpeakerIdentityDecision('viewer', 'record'),
    {
      wrapper,
    }
  )
  setTokens({ accessToken: 'another-login' })
  await act(async () => {
    await expect(result.current.mutateAsync(decision)).rejects.toMatchObject({
      statusCode: 401,
    })
  })
  expect(mocks.fetchApi).not.toHaveBeenCalled()
  expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  expect(
    humanKeys.every((key) => !client.getQueryState(key)?.isInvalidated)
  ).toBe(true)
})

it('rejects a late write response and avoids refreshing the previous viewer', async () => {
  let complete!: (value: unknown) => void
  mocks.fetchApi.mockImplementation(
    () => new Promise((resolve) => (complete = resolve))
  )
  const { result } = renderHook(
    () => useSpeakerIdentityDecision('viewer', 'record'),
    {
      wrapper,
    }
  )
  let write!: Promise<unknown>
  act(() => {
    write = result.current.mutateAsync(decision)
  })
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledOnce())
  expect(mocks.fetchApi.mock.calls[0][1].headers).toEqual({
    'X-Voiceprint-Owner': 'viewer',
  })
  setTokens({ accessToken: 'another-login' })
  await act(async () => {
    const rejected = expect(write).rejects.toMatchObject({ statusCode: 401 })
    complete({ id: 'speaker' })
    await rejected
  })
  expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  expect(
    humanKeys.every((key) => !client.getQueryState(key)?.isInvalidated)
  ).toBe(true)
})

it('discards late directory data after the login changes', async () => {
  let complete!: (value: unknown) => void
  mocks.fetchApi.mockImplementation(
    () => new Promise((resolve) => (complete = resolve))
  )
  const { result } = renderHook(
    () => useSpeakerContacts('viewer', 'record', {}),
    {
      wrapper,
    }
  )
  await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledOnce())
  expect(mocks.fetchApi.mock.calls[0][1].headers).toEqual({
    'X-Voiceprint-Owner': 'viewer',
  })
  const keys = JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
  )
  expect(keys).not.toContain('original-access-token-secret')
  expect(keys).not.toContain('original-refresh-token-secret')
  setTokens({ accessToken: 'another-login' })
  act(() =>
    complete({
      results: [{ ref: 'member:new-user', name: 'Private name' }],
      next_offset: null,
    })
  )
  await waitFor(() => expect(result.current.error?.statusCode).toBe(401))
  expect(result.current.data).toBeUndefined()
  expect(
    client
      .getQueryCache()
      .findAll({ queryKey: ['meeting-records', 'viewer'] })
      .every((query) => query.state.data === undefined)
  ).toBe(true)
})

it('keeps same-session token refresh and ordinary workspace invalidation working', async () => {
  mocks.fetchApi.mockResolvedValue({ id: 'speaker' })
  const { result } = renderHook(
    () => useSpeakerIdentityDecision('viewer', 'record'),
    {
      wrapper,
    }
  )
  expect(
    rotateTokens(getAuthSnapshot(), 'refreshed-access', 'refreshed-refresh')
  ).toBe(true)
  await act(async () => {
    await result.current.mutateAsync(decision)
  })
  expect(mocks.fetchApi).toHaveBeenCalledOnce()
  expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  expect(
    humanKeys.every((key) => client.getQueryState(key)?.isInvalidated)
  ).toBe(true)
  expect(
    client.getQueryState(['human-summary', 'other-viewer', 'record'])
      ?.isInvalidated
  ).toBe(false)
})
