import { useQuery } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import type {
  ApiMeetingRecord,
  ApiRecordSummary,
  ApiRecordTranscript,
  MeetingRecordFilters,
  MeetingRecordPage,
} from './ApiMeetingRecord'

const recordPath = (recordId: string) =>
  `meeting-records/${encodeURIComponent(recordId)}/`

// Viewer identity and immutable record ID are both required in content keys.
// Callers must pass the authenticated viewer ID and the rollout flag.
export const meetingRecordKeys = {
  list: (viewerId: string | undefined, filters: MeetingRecordFilters) =>
    ['meeting-records', viewerId, 'list', filters] as const,
  detail: (viewerId: string | undefined, recordId: string | undefined) =>
    ['meeting-records', viewerId, 'detail', recordId] as const,
  transcripts: (
    viewerId: string | undefined,
    recordId: string | undefined,
    cursor: string | undefined
  ) => ['meeting-records', viewerId, 'transcripts', recordId, cursor] as const,
  summaries: (viewerId: string | undefined, recordId: string | undefined) =>
    ['meeting-records', viewerId, 'summaries', recordId] as const,
}

const privateReadOptions = {
  staleTime: 0,
  gcTime: 0,
  retry: false,
  refetchOnMount: 'always' as const,
}

export const useMeetingRecords = (
  viewerId: string | undefined,
  enabled: boolean,
  filters: MeetingRecordFilters = {}
) =>
  useQuery<MeetingRecordPage<ApiMeetingRecord>, ApiError>({
    ...privateReadOptions,
    queryKey: meetingRecordKeys.list(viewerId, filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.set(key, value)
      })
      return fetchApi(`meeting-records/?${params.toString()}`, { signal })
    },
    enabled: enabled && !!viewerId,
  })

export const useMeetingRecord = (
  viewerId: string | undefined,
  recordId: string | undefined,
  enabled: boolean
) =>
  useQuery<ApiMeetingRecord, ApiError>({
    ...privateReadOptions,
    queryKey: meetingRecordKeys.detail(viewerId, recordId),
    queryFn: ({ signal }) => fetchApi(recordPath(recordId!), { signal }),
    enabled: enabled && !!viewerId && !!recordId,
  })

export const useRecordTranscripts = (
  viewerId: string | undefined,
  recordId: string | undefined,
  enabled: boolean,
  cursor?: string
) =>
  useQuery<MeetingRecordPage<ApiRecordTranscript>, ApiError>({
    ...privateReadOptions,
    queryKey: meetingRecordKeys.transcripts(viewerId, recordId, cursor),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(cursor ? { cursor } : {})
      return fetchApi(`${recordPath(recordId!)}transcripts/?${params}`, {
        signal,
      })
    },
    enabled: enabled && !!viewerId && !!recordId,
  })

export const useRecordSummaries = (
  viewerId: string | undefined,
  recordId: string | undefined,
  enabled: boolean
) =>
  useQuery<{ results: ApiRecordSummary[] }, ApiError>({
    ...privateReadOptions,
    queryKey: meetingRecordKeys.summaries(viewerId, recordId),
    queryFn: ({ signal }) =>
      fetchApi(`${recordPath(recordId!)}summaries/`, { signal }),
    enabled: enabled && !!viewerId && !!recordId,
  })
