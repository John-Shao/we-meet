import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import type {
  ApiMeetingRecord,
  ApiRecordSummary,
  ApiRecordSummaryVersion,
  ApiRecordTranscriptVersion,
  ApiRecordTranscript,
  MeetingRecordFilters,
  MeetingRecordPage,
  LegacyMeetingRecordSource,
  ApiSummaryJob,
  ApiSummaryRequest,
  SummaryRequestPayload,
  SummaryStage,
} from './ApiMeetingRecord'

const recordPath = (recordId: string) =>
  `meeting-records/${encodeURIComponent(recordId)}/`

// Viewer identity and immutable record ID are both required in content keys.
// Callers must pass the authenticated viewer ID and the rollout flag.
export const meetingRecordKeys = {
  resolve: (
    viewerId: string | undefined,
    source: LegacyMeetingRecordSource | undefined
  ) => ['meeting-records', viewerId, 'resolve', source] as const,
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

/** Resolve once to a record ID; callers must surface 409 rather than use latest. */
export const useResolveMeetingRecord = (
  viewerId: string | undefined,
  source: LegacyMeetingRecordSource | undefined,
  enabled: boolean
) =>
  useQuery<ApiMeetingRecord, ApiError>({
    ...privateReadOptions,
    queryKey: meetingRecordKeys.resolve(viewerId, source),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      Object.entries(source!).forEach(([key, value]) => {
        if (value) params.set(key, value)
      })
      return fetchApi(`meeting-records/resolve/?${params}`, { signal })
    },
    enabled: enabled && !!viewerId && !!source,
  })

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
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : 10000,
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

export const useRecordSummaryVersions = (
  viewerId: string | undefined,
  recordId: string | undefined,
  enabled: boolean,
  cursor?: string
) =>
  useQuery<MeetingRecordPage<ApiRecordSummaryVersion>, ApiError>({
    ...privateReadOptions,
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : 10000,
    queryKey: [
      'meeting-records',
      viewerId,
      'summary-versions',
      recordId,
      cursor,
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(cursor ? { cursor } : {})
      return fetchApi(`${recordPath(recordId!)}summary-versions/?${params}`, {
        signal,
      })
    },
    enabled: enabled && !!viewerId && !!recordId,
  })

export const useRecordTranscriptVersion = (
  viewerId: string | undefined,
  recordId: string | undefined,
  snapshotId: string | undefined,
  enabled: boolean
) =>
  useQuery<ApiRecordTranscriptVersion, ApiError>({
    ...privateReadOptions,
    queryKey: [
      'meeting-records',
      viewerId,
      'transcript-version',
      recordId,
      snapshotId,
    ],
    queryFn: ({ signal }) =>
      fetchApi(
        `${recordPath(recordId!)}transcript-versions/${encodeURIComponent(snapshotId!)}/`,
        { signal }
      ),
    enabled: enabled && !!viewerId && !!recordId && !!snapshotId,
  })

export const useRecordSummaryJob = (
  viewerId: string,
  recordId: string,
  enabled: boolean
) =>
  useQuery<
    {
      revision: number
      job: ApiSummaryJob | null
      generation_ready: boolean
      staged_summaries_enabled?: boolean
      ready_stages?: SummaryStage[]
      next_update_at?: string | null
      blocked_reason?: 'source_budget_exceeded'
    },
    ApiError
  >({
    ...privateReadOptions,
    queryKey: ['meeting-records', viewerId, 'summary-job', recordId],
    queryFn: ({ signal }) =>
      fetchApi(`${recordPath(recordId)}summary-job/`, { signal }),
    enabled,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : ['queued', 'running'].includes(query.state.data?.job?.status ?? '')
          ? 3000
          : 10000,
  })

export const useRequestRecordSummary = (viewerId: string, recordId: string) => {
  const client = useQueryClient()
  return useMutation<
    ApiSummaryRequest,
    ApiError,
    { key: string; payload: SummaryRequestPayload }
  >({
    mutationFn: ({ key, payload }) =>
      fetchApi(`${recordPath(recordId)}summary-requests/`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      }),
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
    },
  })
}
export type { SummaryRequestPayload }
