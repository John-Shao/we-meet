import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { OnlineMeetingRecord } from './OnlineMeetingNotes'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('@/features/auth', () => ({ useUser: vi.fn() }))
vi.mock('@livekit/components-react', () => ({ useRoomContext: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./OnlineCaptureControl', () => ({ OnlineCaptureControl: () => null }))
vi.mock('./RecordSummaryPanel', () => ({
  RecordSummaryPanel: ({ recordId }: { recordId: string }) => (
    <div>Summary of {recordId}</div>
  ),
}))

let client: QueryClient
let denied: boolean
let transcriptAllowed: boolean
const transcript = (id: string, text: string) => ({
  id,
  text,
  speaker_name: 'Speaker',
  started_at: '2026-09-12T08:00:00Z',
})
const show = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <OnlineMeetingRecord roomId="room-1" sid="RM_current" viewerId="viewer" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  denied = false
  transcriptAllowed = true
  mocks.fetchApi.mockImplementation(async (url) => {
    if (denied) throw new ApiError(403, {})
    if (url.includes('/resolve/'))
      return {
        id: 'exact-record',
        capabilities: {
          read_transcript: transcriptAllowed,
          read_summary: true,
        },
      }
    if (url.includes('cursor='))
      return { results: [transcript('old', 'Older page')], next_cursor: null }
    return {
      results: [
        transcript('last', 'Latest sentence'),
        transcript('first', 'Earlier sentence'),
      ],
      next_cursor: 'older-token',
    }
  })
})
afterEach(() => client?.clear())

describe('Online exact-session notes', () => {
  it('resolves using the connected SID and reads latest text in chronological order', async () => {
    show()
    await screen.findByText('Latest sentence')
    const url = mocks.fetchApi.mock.calls.find(([value]) =>
      value.includes('/resolve/')
    )![0]
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('room_id')).toBe('room-1')
    expect(params.get('livekit_room_sid')).toBe('RM_current')
    const articles = screen.getAllByRole('article')
    expect(articles[0]).toHaveTextContent('Earlier sentence')
    expect(articles[1]).toHaveTextContent('Latest sentence')
    expect(
      mocks.fetchApi.mock.calls.some(([value]) =>
        value.includes('exact-record/transcripts/?order=latest')
      )
    ).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: 'recordAi.online.earlier' })
    )
    await screen.findByText('Older page')
    fireEvent.click(
      screen.getByRole('button', { name: 'recordAi.online.latest' })
    )
    await screen.findByText('Latest sentence')
    fireEvent.click(
      screen.getByRole('button', { name: 'recordAi.online.summary' })
    )
    await screen.findByText('Summary of exact-record')
  })

  it('never fetches originals for a summary-only share', async () => {
    transcriptAllowed = false
    show()
    await screen.findByText('Summary of exact-record')
    expect(
      screen.queryByRole('button', { name: 'recordAi.online.text' })
    ).not.toBeInTheDocument()
    expect(
      mocks.fetchApi.mock.calls.some(([url]) => url.includes('/transcripts/'))
    ).toBe(false)
  })

  it('does not fall back to another room session when the exact source is unavailable', async () => {
    mocks.fetchApi.mockRejectedValue(new ApiError(404, {}))
    show()
    await screen.findByText('recordAi.online.waiting')
    expect(mocks.fetchApi.mock.calls).toHaveLength(1)
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('removes visible source text after permission revocation', async () => {
    show()
    await screen.findByText('Latest sentence')
    denied = true
    await client.invalidateQueries({ queryKey: ['meeting-records', 'viewer'] })
    await waitFor(() =>
      expect(screen.queryByText('Latest sentence')).not.toBeInTheDocument()
    )
    expect(screen.getByText('recordAi.unavailable')).toBeInTheDocument()
  })
})
