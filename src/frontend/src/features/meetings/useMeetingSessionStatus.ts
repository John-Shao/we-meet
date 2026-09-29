import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'
import { useConnectedMeetingSid } from './useConnectedMeetingSid'

interface MeetingSessionStatus {
  ready: boolean
  interpretation: boolean
  translation: boolean
}

/** LiveKit connects before its room/participant webhooks necessarily reach Django. */
export const useMeetingSessionStatus = () => {
  const room = useRoomData()
  const sid = useConnectedMeetingSid()
  const { user, isLoggedIn } = useUser()
  const roomId = room?.livekit?.room
  const token = room?.livekit?.token
  const status = useQuery<MeetingSessionStatus, ApiError>({
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- credentials must not enter cache keys
    queryKey: [
      'meeting-session-status',
      isLoggedIn ? user?.id : '',
      roomId,
      sid,
    ],
    queryFn: ({ signal }) =>
      fetchApi(
        `meeting-session-status/?${new URLSearchParams({ room_id: roomId!, livekit_room_sid: sid! })}`,
        {
          signal,
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        }
      ),
    enabled: !!roomId && !!sid && !!token,
    staleTime: 1000,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      [401, 403, 404].includes(query.state.error?.statusCode ?? 0)
        ? false
        : 5000,
  })
  return status.isError ? undefined : status.data
}
