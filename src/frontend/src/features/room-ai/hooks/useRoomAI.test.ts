import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { useRoomAI } from './useRoomAI'

const mocks = vi.hoisted(() => ({ sid: 'RM_one', stream: vi.fn() }))
vi.mock('@/features/rooms/livekit/hooks/useRoomData', () => ({
  useRoomData: () => ({
    id: 'room',
    livekit: { room: 'room', token: 'token' },
  }),
}))
vi.mock('@/features/meetings/useConnectedMeetingSid', () => ({
  useConnectedMeetingSid: () => mocks.sid,
}))
vi.mock('@/api/sseStream', () => ({ sseStream: mocks.stream }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.sid = 'RM_one'
})

it('aborts and clears old-session state, ignoring a provider that yields after cancellation', async () => {
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  let signal: AbortSignal | undefined
  mocks.stream.mockImplementation(async function* (_url, options) {
    signal = options.signal
    yield { type: 'delta', text: 'First session' }
    await tail
    yield { type: 'delta', text: 'Late secret' }
  })
  const { result, rerender } = renderHook(() => useRoomAI())
  let pending: Promise<void>
  act(() => {
    pending = result.current.ask('Question')
  })
  await waitFor(() =>
    expect(result.current.messages.at(-1)?.content).toBe('First session')
  )
  mocks.sid = 'RM_two'
  rerender()
  expect(signal?.aborted).toBe(true)
  expect(result.current.messages).toEqual([])
  await act(async () => {
    release()
    await pending!
  })
  expect(result.current.messages).toEqual([])
})

it('retains permission errors as typed errors for the material-access message', async () => {
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'meta' }
    throw new ApiError(403, {})
  })
  const { result } = renderHook(() => useRoomAI())
  await act(async () => {
    await result.current.ask('Question')
  })
  expect(result.current.error).toBeInstanceOf(ApiError)
  expect((result.current.error as ApiError).statusCode).toBe(403)
})
