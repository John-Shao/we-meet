import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { useMeetingSessionStatus } from './useMeetingSessionStatus'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  sid: undefined as string | undefined,
}))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetch }))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ isLoggedIn: true, user: { id: 'viewer' } }),
}))
vi.mock('@/features/rooms/livekit/hooks/useRoomData', () => ({
  useRoomData: () => ({ livekit: { room: 'room', token: 'join-token' } }),
}))
vi.mock('./useConnectedMeetingSid', () => ({
  useConnectedMeetingSid: () => mocks.sid,
}))
let client: QueryClient
const waiting = { ready: false, interpretation: false, translation: false }
const ready = { ready: true, interpretation: true, translation: true }
beforeEach(() => {
  mocks.sid = 'RM_current'
  mocks.fetch.mockReset().mockResolvedValue(waiting)
  client = new QueryClient()
})
afterEach(() => client.clear())
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

it('shares one readiness request and recovers after webhook projection', async () => {
  const { result } = renderHook(
    () => [useMeetingSessionStatus(), useMeetingSessionStatus()],
    { wrapper }
  )
  await waitFor(() => expect(result.current).toEqual([waiting, waiting]))
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.fetch.mock.calls[0][0]).toContain('livekit_room_sid=RM_current')
  expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe(
    'Bearer join-token'
  )
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey)
    )
  ).not.toContain('join-token')
  mocks.fetch.mockResolvedValue(ready)
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['meeting-session-status'] })
  })
  await waitFor(() => expect(result.current).toEqual([ready, ready]))

  mocks.fetch.mockRejectedValue(new ApiError(503, {}))
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['meeting-session-status'] })
  })
  await waitFor(() => expect(result.current).toEqual([undefined, undefined]))
})

it('does not query before connection or reuse readiness across meeting occurrences', async () => {
  mocks.sid = undefined
  const { result, rerender } = renderHook(useMeetingSessionStatus, { wrapper })
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.sid = 'RM_current'
  mocks.fetch.mockResolvedValue(ready)
  rerender()
  await waitFor(() => expect(result.current).toEqual(ready))
  mocks.sid = 'RM_next'
  mocks.fetch.mockResolvedValue(waiting)
  rerender()
  expect(result.current).toBeUndefined()
  await waitFor(() => expect(result.current).toEqual(waiting))
})
