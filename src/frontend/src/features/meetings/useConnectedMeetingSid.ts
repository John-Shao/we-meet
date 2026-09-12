import { useRoomContext } from '@livekit/components-react'
import { ConnectionState, RoomEvent } from 'livekit-client'
import { useEffect, useState } from 'react'

import { useRoomId } from '@/features/rooms/livekit/hooks/useRoomId'

export const useConnectedMeetingSid = () => {
  const room = useRoomContext()
  const roomId = useRoomId()
  const [sid, setSid] = useState<string>()
  useEffect(() => {
    let active = true
    let request = 0
    const update = () => {
      const current = ++request
      setSid(undefined)
      if (room.state === ConnectionState.Connected) {
        void room
          .getSid()
          .then((value) => {
            if (active && request === current) setSid(value)
          })
          .catch(() => {})
      }
    }
    update()
    room.on(RoomEvent.Connected, update)
    room.on(RoomEvent.Reconnected, update)
    room.on(RoomEvent.Disconnected, update)
    return () => {
      active = false
      room.off(RoomEvent.Connected, update)
      room.off(RoomEvent.Reconnected, update)
      room.off(RoomEvent.Disconnected, update)
    }
  }, [room, roomId])
  return sid
}
