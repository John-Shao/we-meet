import { useQuery } from '@tanstack/react-query'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { useUser } from '@/features/auth'

export interface VideoMeeting {
  id: string
  name: string
  slug: string
  is_owner: boolean
  scheduled_at: string | null
  created_at: string
  event_id: string | null
  meeting_session_id: string | null
  started_at: string | null
  ended_at: string | null
  status: 'pending' | 'active' | 'ended'
}

export function useVideoMeetings(enabled: boolean) {
  const { user } = useUser()
  return useQuery<
    { scheduled: VideoMeeting[]; recent: VideoMeeting[] },
    ApiError
  >({
    queryKey: ['video-meetings', user?.id],
    queryFn: ({ signal }) => fetchApi('rooms/video-meetings/', { signal }),
    enabled: enabled && !!user?.id,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 15_000,
  })
}

export function useVideoSession(roomId: string, sessionId?: string | null) {
  const { user } = useUser()
  return useQuery<
    Pick<VideoMeeting, 'status' | 'started_at' | 'ended_at'>,
    ApiError
  >({
    queryKey: ['video-session', user?.id, roomId, sessionId],
    queryFn: ({ signal }) =>
      fetchApi(
        `rooms/${encodeURIComponent(roomId)}/video-session/?session_id=${encodeURIComponent(sessionId!)}`,
        { signal }
      ),
    enabled: !!user?.id && !!sessionId,
    gcTime: 0,
    refetchInterval: 15_000,
  })
}
