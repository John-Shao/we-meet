import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { OnlineCaptureControl } from './OnlineCaptureControl'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let client: QueryClient
let state: {
  available: boolean
  can_control: boolean
  current: null | {
    id: string
    state: string
    record_id: string
    error_code: string
  }
}
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <OnlineCaptureControl roomId="room" sid="RM_current" viewerId="viewer" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  state = { available: true, can_control: true, current: null }
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      state = {
        ...state,
        current: {
          id: 'run',
          record_id: 'record',
          error_code: '',
          state:
            JSON.parse(options.body).operation === 'start'
              ? 'starting'
              : 'stopping',
        },
      }
      return { current: state.current }
    }
    return state
  })
})
afterEach(() => client?.clear())

describe('Online transcription control', () => {
  it('starts explicitly for the exact SID and waits for acknowledgement when stopping', async () => {
    show()
    const start = await screen.findByRole('button', {
      name: 'recordAi.capture.start',
    })
    expect(posts()).toHaveLength(0)
    fireEvent.click(start)
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.capture.stop' })
    )
    await screen.findByText('recordAi.capture.state.stopping')
    expect(
      screen.getByRole('button', { name: 'recordAi.capture.stop' })
    ).toBeDisabled()
    expect(
      screen.queryByText('recordAi.capture.state.stopped')
    ).not.toBeInTheDocument()
    const [first, second] = posts().map(([, options]) =>
      JSON.parse(options.body)
    )
    expect(first).toMatchObject({
      room_id: 'room',
      livekit_room_sid: 'RM_current',
      operation: 'start',
      expected_run_id: null,
    })
    expect(second).toMatchObject({ operation: 'stop', expected_run_id: 'run' })
    expect(first.key).not.toBe(second.key)
  })

  it('replays the same uncertain intent even if the following status read fails', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let lost = false
    mocks.fetchApi.mockImplementation(async (url, options) => {
      if (options?.method === 'POST' && !lost) {
        lost = true
        await fallback(url, options)
        throw new TypeError('lost acknowledgement')
      }
      if (options?.method !== 'POST' && lost) throw new ApiError(503, {})
      return fallback(url, options)
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.capture.start' })
    )
    await screen.findByText('recordAi.uncertain')
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.resubmit' }))
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[0][1].body).toEqual(posts()[1][1].body)
  })

  it('keeps stop available after rollout is disabled and never restarts automatically', async () => {
    state.available = false
    state.current = {
      id: 'run',
      state: 'recording',
      record_id: 'record',
      error_code: '',
    }
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.capture.stop' })
    )
    await screen.findByText('recordAi.capture.state.stopping')
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0][1].body).operation).toBe('stop')
  })

  it('shows state to permitted readers without exposing capture controls', async () => {
    state.can_control = false
    state.current = {
      id: 'run',
      state: 'recording',
      record_id: 'record',
      error_code: '',
    }
    show()
    await screen.findByText('recordAi.capture.state.recording')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(posts()).toHaveLength(0)
  })

  it('hides stale state and controls after access is revoked', async () => {
    show()
    await screen.findByRole('button', { name: 'recordAi.capture.start' })
    mocks.fetchApi.mockRejectedValue(new ApiError(404, {}))
    await client.invalidateQueries({ queryKey: ['meeting-records', 'viewer'] })
    await waitFor(() =>
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    )
    expect(posts()).toHaveLength(0)
  })
})
