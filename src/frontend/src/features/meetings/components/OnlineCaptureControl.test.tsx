import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/ApiError'
import { OnlineCaptureControl } from './OnlineCaptureControl'
import type { CaptureState, CaptureRun } from '../api/ApiOnlineCapture'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let client: QueryClient
const room = '11111111-1111-4111-8111-111111111111'
const run = '22222222-2222-4222-8222-222222222222'
const record = '33333333-3333-4333-8333-333333333333'
let state: CaptureState
const posts = () =>
  mocks.fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <OnlineCaptureControl roomId={room} sid="RM_current" viewerId="viewer" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  sessionStorage.clear()
  state = { available: true, can_control: true, current: null }
  const receipts = new Map<string, CaptureRun>()
  mocks.fetchApi.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      const body = options.body as string
      const previous = receipts.get(body)
      if (previous)
        return { result: previous, current: state.current, replayed: true }
      const result: CaptureRun = {
        id: run,
        record_id: record,
        error_code: '',
        coverage: 'unverified',
        started_at: null,
        ended_at: null,
        state: JSON.parse(body).operation === 'start' ? 'starting' : 'stopping',
      }
      state = { ...state, current: result }
      receipts.set(body, result)
      return { result, current: result, replayed: false }
    }
    return state
  })
})
afterEach(() => {
  client?.clear()
  vi.restoreAllMocks()
})

describe('Online transcription control', () => {
  it.each([401, 403, 404, 408, 429, 503])(
    'retains the original request after HTTP %s',
    async (status) => {
      const fallback = mocks.fetchApi.getMockImplementation()!
      let reject = true
      mocks.fetchApi.mockImplementation(async (url, options) => {
        if (options?.method === 'POST' && reject) {
          await fallback(url, options)
          throw new ApiError(status, {})
        }
        return fallback(url, options)
      })
      const first = show()
      fireEvent.click(
        await screen.findByRole('button', { name: 'recordAi.capture.start' })
      )
      await screen.findByText('recordAi.uncertain')
      const original = posts()[0][1].body
      first.unmount()
      client.clear()
      reject = false
      show()
      const retry = await screen.findByRole('button', {
        name: 'recordAi.resubmit',
      })
      expect(posts()).toHaveLength(1)
      fireEvent.click(retry)
      await screen.findByRole('button', { name: 'recordAi.capture.stop' })
      expect(posts()[1][1].body).toBe(original)
      expect(sessionStorage.length).toBe(0)
    }
  )

  it('treats malformed success as unknown and keeps the exact request', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    let malformed = true
    mocks.fetchApi.mockImplementation(async (url, options) => {
      const value = await fallback(url, options)
      return options?.method === 'POST' && malformed
        ? { current: state.current }
        : value
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.capture.start' })
    )
    await screen.findByText('recordAi.uncertain')
    malformed = false
    fireEvent.click(screen.getByRole('button', { name: 'recordAi.resubmit' }))
    await screen.findByRole('button', { name: 'recordAi.capture.stop' })
    expect(posts()[0][1].body).toBe(posts()[1][1].body)
  })

  it('does not dispatch if the browser cannot persist recovery metadata', async () => {
    show()
    const start = await screen.findByRole('button', {
      name: 'recordAi.capture.start',
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    fireEvent.click(start)
    await screen.findByText('recordAi.recoveryError')
    expect(posts()).toHaveLength(0)
    expect(
      screen.queryByRole('button', { name: 'recordAi.capture.start' })
    ).not.toBeInTheDocument()
  })

  it('does not carry pending operations into another account or occurrence', async () => {
    const fallback = mocks.fetchApi.getMockImplementation()!
    mocks.fetchApi.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') throw new ApiError(503, {})
      return fallback(url, options)
    })
    const view = show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'recordAi.capture.start' })
    )
    await screen.findByText('recordAi.uncertain')
    view.rerender(
      <QueryClientProvider client={client}>
        <OnlineCaptureControl
          roomId={room}
          sid="RM_other"
          viewerId="different"
        />
      </QueryClientProvider>
    )
    await screen.findByRole('button', { name: 'recordAi.capture.start' })
    expect(
      screen.queryByRole('button', { name: 'recordAi.resubmit' })
    ).not.toBeInTheDocument()
    expect(posts()).toHaveLength(1)
    view.rerender(
      <QueryClientProvider client={client}>
        <OnlineCaptureControl
          roomId={room}
          sid="RM_current"
          viewerId="viewer"
        />
      </QueryClientProvider>
    )
    await screen.findByRole('button', { name: 'recordAi.resubmit' })
    expect(posts()).toHaveLength(1)
  })

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
      room_id: room,
      livekit_room_sid: 'RM_current',
      operation: 'start',
      expected_run_id: null,
    })
    expect(second).toMatchObject({ operation: 'stop', expected_run_id: run })
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
      id: run,
      state: 'recording',
      record_id: record,
      error_code: '',
      coverage: 'unverified',
      started_at: null,
      ended_at: null,
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
      id: run,
      state: 'recording',
      record_id: record,
      error_code: '',
      coverage: 'unverified',
      started_at: null,
      ended_at: null,
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
