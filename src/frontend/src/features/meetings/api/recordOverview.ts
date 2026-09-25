import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import type {
  ApiSummaryJob,
  RecordSourceReference,
  SummaryRequestPayload,
} from './ApiMeetingRecord'
import { summaryReceipt } from './summaryReceipts'

export const overviewLanguages = {
  auto: '',
  zh: '中文',
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  nl: 'Nederlands',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
}
export type OverviewLanguage = keyof typeof overviewLanguages

export interface RecordOverviewState {
  revision: number
  available: boolean
  can_generate: boolean
  generation_ready: boolean
  output_language?: OverviewLanguage
  job: ApiSummaryJob | null
  version: {
    id: string
    created_at: string
    input_snapshot_id: string
    input_revision: number
    is_current: boolean
    asr_status: string
    content: {
      synopsis: string
      topics: {
        title: string
        text: string
        source_refs: RecordSourceReference[]
      }[]
    }
  } | null
}

export function useSetOverviewLanguage(viewerId: string, recordId: string) {
  const client = useQueryClient()
  const queryKey = ['meeting-records', viewerId, 'overview', recordId]
  return useMutation({
    mutationFn: (payload: {
      output_language: OverviewLanguage
      expected_output_language: OverviewLanguage
    }) =>
      fetchApi<{ output_language: OverviewLanguage }>(
        `meeting-records/${encodeURIComponent(recordId)}/overview/`,
        {
          method: 'PATCH',
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify(payload),
          cache: 'no-store',
        }
      ),
    retry: false,
    onSuccess: (data) =>
      client.setQueryData<RecordOverviewState>(queryKey, (old) =>
        old ? { ...old, output_language: data.output_language } : old
      ),
    onSettled: () => client.invalidateQueries({ queryKey }),
  })
}

export function useRecordOverview(viewerId: string, recordId: string) {
  return useQuery<RecordOverviewState, ApiError>({
    queryKey: ['meeting-records', viewerId, 'overview', recordId],
    queryFn: ({ signal }) =>
      fetchApi(`meeting-records/${encodeURIComponent(recordId)}/overview/`, {
        signal,
        cache: 'no-store',
      }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.error
        ? false
        : ['queued', 'running'].includes(query.state.data?.job?.status ?? '')
          ? 3000
          : 10000,
  })
}

export function useRequestOverview(viewerId: string, recordId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({
      key,
      payload,
    }: {
      key: string
      payload: SummaryRequestPayload
    }) =>
      summaryReceipt(
        await fetchApi(
          `meeting-records/${encodeURIComponent(recordId)}/overview-requests/`,
          {
            method: 'POST',
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
            headers: { 'Idempotency-Key': key },
            body: JSON.stringify(payload),
          }
        ),
        payload
      ),
    retry: false,
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['meeting-records', viewerId, 'overview', recordId],
      }),
  })
}
