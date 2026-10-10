import { EventEmitter } from 'node:events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { ConnectionState, RoomEvent } from 'livekit-client'
import { beforeEach, expect, it, vi } from 'vitest'
import { useConnectedMeetingSid } from './useConnectedMeetingSid'

const fixture = vi.hoisted(() => ({
  room: undefined as unknown,
  roomId: 'synthetic-room',
}))
vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => fixture.room,
}))
vi.mock('@/features/rooms/livekit/hooks/useRoomId', () => ({
  useRoomId: () => fixture.roomId,
}))
class SyntheticRoom extends EventEmitter {
  state = ConnectionState.Connected
  getSid = vi.fn(async () => 'RM_synthetic')
}
let room: SyntheticRoom
beforeEach(() => {
  room = new SyntheticRoom()
  fixture.room = room
  fixture.roomId = 'synthetic-room'
})

it('clears on reconnecting even if the SDK state transition has not reached the event handler', async () => {
  const { result } = renderHook(useConnectedMeetingSid)
  await waitFor(() => expect(result.current).toBe('RM_synthetic'))
  act(() => {
    room.emit(RoomEvent.Reconnecting)
  })
  expect(result.current).toBeUndefined()
  expect(room.getSid).toHaveBeenCalledOnce()
  act(() => {
    room.emit(RoomEvent.Reconnected)
  })
  await waitFor(() => expect(result.current).toBe('RM_synthetic'))
})

it('rejects a late SID after disconnect and removes listeners on unmount', async () => {
  let finish!: (sid: string) => void
  room.getSid.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result, unmount } = renderHook(useConnectedMeetingSid)
  act(() => {
    room.emit(RoomEvent.Disconnected)
  })
  await act(async () => {
    finish('RM_old')
  })
  expect(result.current).toBeUndefined()
  unmount()
  expect(room.eventNames()).toEqual([])
})

it('cannot leak the old room SID into a replacement room', async () => {
  let finish!: (sid: string) => void
  room.getSid.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(useConnectedMeetingSid)
  fixture.room = new SyntheticRoom()
  fixture.roomId = 'replacement-room'
  rerender()
  await waitFor(() => expect(result.current).toBe('RM_synthetic'))
  await act(async () => {
    finish('RM_old')
  })
  expect(result.current).toBe('RM_synthetic')
  expect(room.eventNames()).toEqual([])
})
