import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import { ApiRoom } from '@/features/rooms/api/ApiRoom'

import {
  ApiActionItem,
  ApiRecentMeeting,
  ApiRoomDetail,
  ApiSummary,
  ApiTranscript,
} from './ApiMeeting'

const fetchRoom = (roomId: string) =>
  fetchApi<ApiRoomDetail>(`rooms/${roomId}/`)

export const useMeetingRoom = (roomId: string | undefined) =>
  useQuery<ApiRoomDetail, ApiError>({
    queryKey: ['meeting-room', roomId],
    queryFn: () => fetchRoom(roomId!),
    enabled: !!roomId,
  })

const fetchSummary = (roomId: string) =>
  fetchApi<ApiSummary>(`rooms/${roomId}/summary/`)

export const useMeetingSummary = (roomId: string | undefined) =>
  useQuery<ApiSummary, ApiError>({
    queryKey: ['meeting-summary', roomId],
    queryFn: () => fetchSummary(roomId!),
    enabled: !!roomId,
    retry: false,
    // 404 = no summary yet — don't keep retrying.
  })

const fetchActionItems = (roomId: string) =>
  fetchApi<ApiActionItem[]>(`rooms/${roomId}/action-items/`)

export const useMeetingActionItems = (roomId: string | undefined) =>
  useQuery<ApiActionItem[], ApiError>({
    queryKey: ['meeting-action-items', roomId],
    queryFn: () => fetchActionItems(roomId!),
    enabled: !!roomId,
  })

const fetchTranscripts = (roomId: string) =>
  fetchApi<ApiTranscript[]>(`rooms/${roomId}/transcripts/`)

export const useMeetingTranscripts = (roomId: string | undefined) =>
  useQuery<ApiTranscript[], ApiError>({
    queryKey: ['meeting-transcripts', roomId],
    queryFn: () => fetchTranscripts(roomId!),
    enabled: !!roomId,
  })

const fetchRecentMeetings = () =>
  fetchApi<ApiRecentMeeting[]>(`rooms/recent-meetings/`)

export const useRecentMeetings = (enabled: boolean = true) =>
  useQuery<ApiRecentMeeting[], ApiError>({
    queryKey: ['recent-meetings'],
    queryFn: fetchRecentMeetings,
    enabled,
    staleTime: 30_000,
  })

interface PagedRooms {
  count: number
  next: string | null
  previous: string | null
  results: ApiRoom[]
}

/**
 * Upcoming scheduled meetings — rooms the user is a member of whose
 * `scheduled_at` is today or later and that aren't already closed.
 * Today's already-passed slots stay (e.g. a 9am that's now 10am) and
 * roll off at midnight; earlier days drop. Sorted ascending so the
 * soonest one is on top.
 *
 * Source endpoint is the same paginated `/rooms/` the App uses; only
 * the first page is consumed (50 rooms is far more than any user will
 * have pending at once).
 */
const fetchScheduledMeetings = async (): Promise<ApiRoom[]> => {
  const page = await fetchApi<PagedRooms>(`rooms/?page_size=50`)
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  return page.results
    .filter((r) => !!r.scheduled_at && !r.closed_at)
    .filter((r) => new Date(r.scheduled_at as string).getTime() >= todayMs)
    .sort(
      (a, b) =>
        new Date(a.scheduled_at as string).getTime() -
        new Date(b.scheduled_at as string).getTime()
    )
}

export const useScheduledMeetings = (enabled: boolean = true) =>
  useQuery<ApiRoom[], ApiError>({
    queryKey: ['scheduled-meetings'],
    queryFn: fetchScheduledMeetings,
    enabled,
    staleTime: 30_000,
  })

const regenerateSummary = (roomId: string) =>
  fetchApi<{ status: string }>(`rooms/${roomId}/summary/regenerate/`, {
    method: 'POST',
  })

export const useRegenerateSummary = (roomId: string | undefined) => {
  const qc = useQueryClient()
  return useMutation<{ status: string }, ApiError>({
    mutationFn: () => regenerateSummary(roomId!),
    onSuccess: () => {
      // The backend just scheduled the task; depending on CELERY_ENABLED
      // the new rows show up within milliseconds (sync fallback) or a
      // few seconds. Invalidate so a manual / quick refetch picks up the
      // refreshed summary + items.
      qc.invalidateQueries({ queryKey: ['meeting-summary', roomId] })
      qc.invalidateQueries({ queryKey: ['meeting-action-items', roomId] })
    },
  })
}
