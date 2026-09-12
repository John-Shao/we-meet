import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { RecordSummaryPanel, RoomRecordSummaries } from './RecordSummaryPanel'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const record = {
  id: 'record-1',
  title: 'Specific meeting',
  origin_at: '2026-09-12T08:00:00Z',
  revision: 1,
  capabilities: {
    read_summary: true,
    read_transcript: true,
    generate_summary: true,
  },
}
const version = {
  id: 'version-1',
  created_at: '2026-09-12T09:00:00Z',
  is_current: true,
  input_snapshot_id: 'snapshot-1',
  delivery_status: 'complete',
  coverage_status: 'unverified',
  content: {
    overview: 'Protected minutes',
    decisions: [
      {
        text: 'Decision',
        source_refs: [
          {
            segment_id: 'segment-1',
            segment_revision: 1,
            start_ms: 0,
            end_ms: 1000,
          },
        ],
      },
    ],
    chapters: [],
    action_items: [],
    open_questions: [],
  },
}
let client: QueryClient
let currentRecord: typeof record
let job: { id: string; status: string; attempt: number } | null
let readError: boolean
let withVersion: boolean

function show(roomList = false) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      {roomList ? (
        <RoomRecordSummaries viewerId="viewer-1" roomId="room-1" />
      ) : (
        <RecordSummaryPanel viewerId="viewer-1" recordId="record-1" />
      )}
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  currentRecord = structuredClone(record)
  job = null
  readError = false
  withVersion = false
  mocks.fetchApi.mockImplementation(
    async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST')
        return { request_id: 'intent-1', replayed: false, job }
      if (readError) throw new ApiError(403, {})
      if (url.includes('summary-job/'))
        return { revision: 1, job, generation_ready: true }
      if (url.includes('summary-versions/'))
        return { results: withVersion ? [version] : [], next_cursor: null }
      if (url.includes('transcript-versions/'))
        return {
          id: 'snapshot-1',
          revision: 1,
          segments: [
            {
              ...version.content.decisions[0].source_refs[0],
              text: 'Historical original text',
            },
          ],
        }
      if (url.includes('?room_id='))
        return {
          results: [
            currentRecord,
            { ...currentRecord, id: 'record-2', title: 'Another session' },
          ],
          next_cursor: null,
        }
      return currentRecord
    }
  )
})
afterEach(() => client?.clear())

describe('Versioned summary requests', () => {
  it('submits one explicit intent despite a double click', async () => {
    let resolve: (value: unknown) => void = () => {}
    const fallback = mocks.fetchApi.getMockImplementation()!
    mocks.fetchApi.mockImplementation((url, options) =>
      options?.method === 'POST'
        ? new Promise((done) => {
            resolve = done
          })
        : fallback(url, options)
    )
    show()
    const generate = await screen.findByRole('button', {
      name: 'recordAi.generate',
    })
    fireEvent.click(generate)
    fireEvent.click(generate)
    await waitFor(() =>
      expect(
        mocks.fetchApi.mock.calls.filter(
          ([, options]) => options?.method === 'POST'
        )
      ).toHaveLength(1)
    )
    const [, request] = mocks.fetchApi.mock.calls.find(
      ([, options]) => options?.method === 'POST'
    )!
    expect(JSON.parse(request.body)).toEqual({
      operation: 'generate',
      expected_revision: 1,
      expected_job_id: null,
      expected_attempt: null,
    })
    expect(request.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    resolve({ request_id: 'intent-1', job: null })
    await screen.findByText('recordAi.accepted')
  })

  it('retains the same payload and key after an uncertain network result', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let writes = 0
    mocks.fetchApi.mockImplementation((url, options) => {
      if (options?.method !== 'POST') return fallback(url, options)
      writes++
      if (writes === 1) {
        job = { id: 'job-1', attempt: 1, status: 'queued' }
        return Promise.reject(new TypeError('network disconnected'))
      }
      if (writes === 2) return Promise.reject(new ApiError(429, {}))
      return Promise.resolve({ request_id: 'intent-1', job })
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.generate' })
    )
    await screen.findByText('recordAi.uncertain')
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.resubmit' }))
    await screen.findByText('recordAi.rateLimited')
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.resubmit' }))
    await screen.findByText('recordAi.accepted')
    const posts = mocks.fetchApi.mock.calls.filter(
      ([, options]) => options?.method === 'POST'
    )
    expect(posts).toHaveLength(3)
    expect(posts[0][1]).toEqual(posts[1][1])
    expect(posts[0][1]).toEqual(posts[2][1])
  })

  it('keeps read-only shares from generating or loading original text', async () => {
    currentRecord.capabilities = {
      read_summary: true,
      read_transcript: false,
      generate_summary: false,
    }
    withVersion = true
    show()
    await screen.findByText('Protected minutes')
    expect(
      screen.queryByRole('button', { name: 'recordAi.generate' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /recordAi.source/ })
    ).not.toBeInTheDocument()
    expect(
      mocks.fetchApi.mock.calls.some(([url]) =>
        url.includes('transcript-versions')
      )
    ).toBe(false)
    expect(screen.getByText(/recordAi.coverageUnverified/)).toBeInTheDocument()
  })

  it('opens citations against their own immutable snapshot', async () => {
    withVersion = true
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.source 0:00' })
    )
    await screen.findByText('Historical original text')
    expect(
      mocks.fetchApi.mock.calls.some(
        ([url]) =>
          url === 'meeting-records/record-1/transcript-versions/snapshot-1/'
      )
    ).toBe(true)
  })

  it('hides cached content when refreshed access is revoked', async () => {
    withVersion = true
    show()
    await screen.findByText('Protected minutes')
    readError = true
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.refresh' }))
    await screen.findByText('recordAi.unavailable')
    expect(screen.queryByText('Protected minutes')).not.toBeInTheDocument()
  })

  it('requires explicit selection for reused meeting rooms', async () => {
    show(true)
    await screen.findByText(/Another session/)
    expect(
      mocks.fetchApi.mock.calls.some(([url]) => url.includes('summary-job'))
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Another session/ }))
    await screen.findByRole('button', { name: 'recordAi.generate' })
    expect(
      mocks.fetchApi.mock.calls.some(
        ([url]) => url === 'meeting-records/record-2/summary-job/'
      )
    ).toBe(true)
  })
})
