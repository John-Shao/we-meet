import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { summaryReceipt } from './summaryReceipts'

import type {
  ApiMeetingRecord,
  ApiRecordSummary,
  ApiRecordSummaryVersion,
  ApiRecordTranscriptVersion,
  ApiRecordTranscript,
  ApiRecordSpeaker,
  ApiAttributionCandidate,
  MeetingRecordFilters,
  MeetingRecordPage,
  LegacyMeetingRecordSource,
  ApiSummaryJob,
  ApiSummaryRequest,
  RecordTitlePayload,
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
    refetchInterval: (query) =>
      query.state.status === 'error' ? false : 15000,
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

/**
 * Speakers of a record's original text, for the transcript filter.
 *
 * Read once per viewer/record/revision rather than polled: the speaker set only
 * changes when new text is published, and `revision` already tracks that.
 */
export const useRecordSpeakers = (
  viewerId: string | undefined,
  recordId: string | undefined,
  revision: number | undefined,
  enabled: boolean
) =>
  useQuery<MeetingRecordPage<ApiRecordSpeaker>, ApiError>({
    ...privateReadOptions,
    queryKey: ['meeting-records', viewerId, 'speakers', recordId, revision],
    queryFn: ({ signal }) =>
      fetchApi(`${recordPath(recordId!)}speakers/`, { signal }),
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
  cursor?: string,
  versionId?: string
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
      versionId,
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(
        versionId !== undefined
          ? { version_id: versionId }
          : cursor
            ? { cursor }
            : {}
      )
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
    mutationFn: async ({ key, payload }) =>
      summaryReceipt(
        await fetchApi<unknown>(`${recordPath(recordId)}summary-requests/`, {
          method: 'POST',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(payload),
        }),
        payload
      ),
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

/** What the server reports back for one corrected segment. */
export interface ApiSegmentCorrection {
  correction_revision: number
  record_revision: number
  id: string
  text: string
  original_text: string
  is_corrected: boolean
  /** Null when the submission matched what the segment already said. */
  revision: number | null
}

/**
 * Correct one transcript segment, or append a restoration of the original.
 *
 * The write appends a revision and never rewrites the original, so a reader can
 * always see what the recogniser produced. `expectedRevision` guards a
 * concurrent edit: the server answers 409 rather than letting the later saver
 * silently overwrite the earlier one.
 */
export const useCorrectOriginalSegment = (
  viewerId: string,
  recordId: string
) => {
  const client = useQueryClient()
  const segmentPath = (segmentId: string) =>
    `${recordPath(recordId)}original-segments/${encodeURIComponent(segmentId)}/`
  return useMutation<
    ApiSegmentCorrection,
    ApiError,
    {
      segmentId: string
      text?: string
      expectedRevision: number
      revert?: boolean
    }
  >({
    mutationFn: ({ segmentId, text, expectedRevision, revert }) =>
      fetchApi<ApiSegmentCorrection>(
        segmentPath(segmentId) +
          (revert ? `?expected_revision=${expectedRevision}` : ''),
        {
          method: revert ? 'DELETE' : 'PATCH',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          ...(revert
            ? {}
            : {
                body: JSON.stringify({
                  text,
                  expected_revision: expectedRevision,
                }),
              }),
        }
      ),
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      // The corrected text is projected into every transcript read, so the list
      // has to re-read rather than be patched locally.
      await Promise.all([
        client.invalidateQueries({ queryKey: ['meeting-records', viewerId] }),
        client.invalidateQueries({ queryKey: ['capture-originals', viewerId] }),
        client.invalidateQueries({
          queryKey: ['record-library-content', viewerId],
        }),
      ])
    },
    onError: async (error) => {
      // Refresh the version to compare with, while the editor retains its draft
      // and the version it originally opened against.
      if ([401, 403, 404, 409].includes(error.statusCode)) {
        await client.invalidateQueries({
          queryKey: ['capture-originals', viewerId],
        })
      }
    },
  })
}

/**
 * People this reader may bind a speaker track to.
 *
 * Read at the moment the picker opens rather than on mount: most readers never
 * attribute anyone, and the server draws the list from the same directory the
 * write accepts, so there is no point holding it in the cache.
 */
export const useAttributionCandidates = (
  viewerId: string | undefined,
  recordId: string | undefined,
  query: string,
  enabled: boolean
) =>
  useQuery<{ results: ApiAttributionCandidate[] }, ApiError>({
    ...privateReadOptions,
    // A search keeps the previous list on screen: blanking it mid-keystroke
    // looks like "nobody matches" while the request is still in flight.
    placeholderData: keepPreviousData,
    queryKey: [
      'meeting-records',
      viewerId,
      'attribution-candidates',
      recordId,
      query,
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(query ? { q: query } : {})
      return fetchApi(
        `${recordPath(recordId!)}attribution-candidates/?${params}`,
        { signal }
      )
    },
    enabled: enabled && !!viewerId && !!recordId,
  })

/**
 * Bind a speaker track to a person, or clear the binding.
 *
 * Attribution never rewrites the recogniser's label — the server keeps it and
 * resolves one name for readers — so the transcript has to be re-read rather
 * than patched locally.
 */
export const useAttributeSpeaker = (viewerId: string, recordId: string) => {
  const client = useQueryClient()
  return useMutation<
    ApiRecordSpeaker,
    ApiError,
    { speakerId: string; userId: string | null }
  >({
    mutationFn: ({ speakerId, userId }) =>
      fetchApi<ApiRecordSpeaker>(
        `${recordPath(recordId)}speakers/${encodeURIComponent(speakerId)}/`,
        {
          method: 'PATCH',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ user_id: userId }),
        }
      ),
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ['meeting-records', viewerId],
      })
    },
  })
}

/**
 * Rename an ended standalone recording. The backend rejects with 409 when
 * `expected_title` no longer matches, so callers must surface the conflict and
 * re-read rather than silently overwriting someone else's change.
 */
export const useRenameMeetingRecord = (viewerId: string, recordId: string) => {
  const client = useQueryClient()
  return useMutation<ApiMeetingRecord, ApiError, RecordTitlePayload>({
    mutationFn: (payload) =>
      fetchApi<ApiMeetingRecord>(`${recordPath(recordId)}title/`, {
        method: 'PATCH',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
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
