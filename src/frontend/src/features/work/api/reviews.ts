import { fetchApi } from '@/api/fetchApi'

export interface ReviewFile {
  name: string
  sha256: string
}
export interface WorkReview {
  id: string
  source_run_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  error_code: string
  model: string
  selection: ReviewFile[]
  snapshot: ReviewFile[]
  reserved_tokens: number
  input_tokens: number | null
  output_tokens: number | null
  report: {
    verdict?: 'no_issues' | 'needs_changes' | 'inconclusive'
    summary?: string
    findings?: {
      severity: 'error' | 'warning'
      message: string
      evidence: { file: string; sha256: string; quote: string }[]
    }[]
    missing_information?: string[]
  }
}
export const listReviews = (runId: string) =>
  fetchApi<WorkReview[]>(`work/runs/${runId}/reviews/`)
export const createReview = (runId: string, files: ReviewFile[], key: string) =>
  fetchApi<WorkReview>(`work/runs/${runId}/reviews/`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ files }),
  })
export const cancelReview = (runId: string, reviewId: string) =>
  fetchApi<WorkReview>(`work/runs/${runId}/reviews/${reviewId}/cancel/`, {
    method: 'POST',
    body: '{}',
  })
