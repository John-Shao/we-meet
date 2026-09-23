import { fetchApi, fetchApiBlob } from '@/api/fetchApi'
import type { Material } from './materials'

export interface WorkRun {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  error_code: string
  model: string
  reserved_tokens: number
  input_tokens: number | null
  output_tokens: number | null
}
export interface WorkTask {
  id: string
  recipient: string
  goal: string
  background: string
  sources: Pick<Material, 'id' | 'checksum' | 'parser_version' | 'generation'>[]
  runs: WorkRun[]
}
export interface Artifact {
  version: number
  body: string
  origin: 'generated' | 'edited'
  adopted_at: string | null
  citations: {
    source_id: string
    name: string
    location: string
    line: number
    quote: string
  }[]
}
export type TaskInput = Pick<
  WorkTask,
  'recipient' | 'goal' | 'background' | 'sources'
>
export interface RunEvent {
  seq: number
  type: string
  created_at: string
}
export const getRunEvents = (id: string, after: number) =>
  fetchApi<{ run: WorkRun; events: RunEvent[]; next_after: number }>(
    `work/runs/${id}/events/?after=${after}`
  )
export const listTasks = (page: number) =>
  fetchApi<{
    results: WorkTask[]
    next: string | null
    previous: string | null
  }>(`work/tasks/?page=${page}`)
export const getTask = (id: string) => fetchApi<WorkTask>(`work/tasks/${id}/`)
export const createTask = (
  data: TaskInput,
  key: string,
  signal?: AbortSignal
) =>
  fetchApi<WorkTask>('work/tasks/', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(data),
    signal,
  })
export const retryTask = (id: string, key: string) =>
  fetchApi<WorkRun>(`work/tasks/${id}/retry/`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: '{}',
  })
export const cancelRun = (id: string) =>
  fetchApi<WorkRun>(`work/runs/${id}/cancel/`, { method: 'POST', body: '{}' })
export const getArtifact = (id: string, version?: number) =>
  fetchApi<Artifact>(
    `work/runs/${id}/artifact/${version ? `?version=${version}` : ''}`
  )
export const saveArtifact = (id: string, base_version: number, body: string) =>
  fetchApi<Artifact>(`work/runs/${id}/artifact/`, {
    method: 'POST',
    body: JSON.stringify({ base_version, body }),
  })
export const adoptArtifact = (id: string, version: number) =>
  fetchApi<Artifact>(`work/runs/${id}/adopt/`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
export const downloadArtifact = (id: string, version: number) =>
  fetchApiBlob(`work/runs/${id}/download/?version=${version}`, {}, 200_000)
