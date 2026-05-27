import { useQuery } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import {
  ApiActionItem,
  ApiSummary,
  ApiTranscript,
} from './ApiMeeting'

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
