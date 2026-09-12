import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { OnlineCaptureNoticeState } from './OnlineCaptureNotice'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../useConnectedMeetingSid', () => ({
  useConnectedMeetingSid: vi.fn(),
}))
vi.mock('@/features/rooms/livekit/hooks/useRoomData', () => ({
  useRoomData: vi.fn(),
}))
let client: QueryClient
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <OnlineCaptureNoticeState
        roomId="room"
        sid="RM_current"
        token="join-token"
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.fetchApi.mockResolvedValue({ state: 'recording' })
})
afterEach(() => client?.clear())

describe('Meeting capture notice', () => {
  it('uses the join token for exact current-session status without requesting materials', async () => {
    show()
    expect(await screen.findByRole('status')).toHaveTextContent(
      'recordAi.capture.state.recording'
    )
    expect(mocks.fetchApi).toHaveBeenCalledTimes(1)
    const [url, options] = mocks.fetchApi.mock.calls[0]
    expect(url).toContain('meeting-capture-status/')
    expect(url).toContain('livekit_room_sid=RM_current')
    expect(options.headers.Authorization).toBe('Bearer join-token')
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain('join-token')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('does not claim recording is off when the status request fails after recording was observed', async () => {
    show()
    await screen.findByRole('status')
    mocks.fetchApi.mockRejectedValue(new ApiError(503, {}))
    await client.invalidateQueries({ queryKey: ['online-capture-notice'] })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'recordAi.capture.unavailable'
      )
    )
    expect(
      screen.queryByText('recordAi.capture.state.stopped')
    ).not.toBeInTheDocument()
  })
  it('does not introduce a banner in meetings without managed capture', async () => {
    mocks.fetchApi.mockResolvedValue({ state: 'off' })
    show()
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
