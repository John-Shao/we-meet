import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import {
  useInterpretation,
  type InterpretationState,
} from '../interpretationContext'
import type {
  InterpretationStatus,
  InterpretationSubscription,
} from '../interpretationEvents'
import { InterpretationProvider } from './InterpretationProvider'

type Listener = (...args: unknown[]) => void
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  room: {} as Record<string, unknown>,
}))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetch }))
vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => mocks.room,
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ isLoggedIn: true, user: { id: 'viewer' } }),
}))
vi.mock('@/features/rooms/livekit/hooks/useRoomId', () => ({
  useRoomId: () => 'room',
}))
vi.mock('../useConnectedMeetingSid', () => ({
  useConnectedMeetingSid: () => 'RM_current',
}))
const ids = {
  en: '11111111-1111-4111-8111-111111111111',
  zh: '22222222-2222-4222-8222-222222222222',
  sub: '33333333-3333-4333-8333-333333333333',
  participation: '44444444-4444-4444-8444-444444444444',
  source: '55555555-5555-4555-8555-555555555555',
}
let client: QueryClient
let latest: InterpretationState
let status: InterpretationStatus
let listeners: Map<string, Set<Listener>>
let sender: RemoteParticipant
let now: number
const posts = () =>
  mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
const sub = (): InterpretationSubscription => ({
  id: ids.sub,
  channel_id: ids.en,
  participation_id: ids.participation,
  revision: 1,
  active: true,
  expires_at: '2026-09-13T00:00:20Z',
  remaining_lease_seconds: 20,
})
function Probe() {
  latest = useInterpretation()!
  return null
}
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <InterpretationProvider>
        <Probe />
      </InterpretationProvider>
    </QueryClientProvider>
  )
}
function emit(changed: object = {}, from = sender) {
  act(() =>
    listeners.get(RoomEvent.DataReceived)?.forEach((fn) =>
      fn(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'ready',
            channel_id: ids.en,
            generation: 1,
            target: 'en',
            subscription_id: ids.sub,
            subscription_revision: status.subscriptions[0]?.revision ?? 1,
            source_participation_id: ids.source,
            source_participant_sid: 'PA_source',
            audio_track_sid: 'TR_voice',
            ...changed,
          })
        ),
        from,
        undefined,
        'meeting.interpretation.events'
      )
    )
  )
}
beforeEach(() => {
  sessionStorage.clear()
  now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  mocks.fetch.mockReset()
  listeners = new Map()
  sender = {
    identity: `interpretation-${ids.en}-worker`,
    sid: 'PA_agent',
    isAgent: true,
  } as RemoteParticipant
  mocks.room = {
    localParticipant: { sid: 'PA_self' },
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: (event: string, fn: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    off: (event: string, fn: Listener) => listeners.get(event)?.delete(fn),
  }
  status = {
    available: true,
    can_control: true,
    languages: ['zh', 'en'],
    listener_lease_seconds: 20,
    connections: [{ id: ids.participation, participant_sid: 'PA_self' }],
    subscriptions: [],
    channels: [
      {
        id: ids.en,
        target: 'en',
        state: 'translating',
        generation: 1,
        error_code: '',
      },
      {
        id: ids.zh,
        target: 'zh',
        state: 'prepared',
        generation: 1,
        error_code: '',
      },
    ],
  }
  mocks.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body))
      if (url.endsWith('subscription/')) {
        status = {
          ...status,
          subscriptions: [
            {
              ...sub(),
              channel_id: body.channel_id,
              revision: body.expected_revision + 1,
              active: body.operation === 'join',
            },
          ],
        }
      }
      if (url.endsWith('renew/')) return status.subscriptions[0]
      return { result: {}, replayed: false }
    }
    return structuredClone(status)
  })
})
afterEach(() => {
  cleanup()
  client?.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Shared interpretation listener lifecycle', () => {
  it('never starts or resumes listening from a backend subscription alone', async () => {
    status.subscriptions = [sub()]
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    emit()
    expect(latest.listening).toBeUndefined()
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    expect(posts()).toHaveLength(0)
  })
  it('requires explicit join and matching ready metadata before attaching audio', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    emit({ subscription_revision: 0 })
    expect(latest.ready).toBe(false)
    emit()
    expect(latest.canPlay(sender, 'TR_voice')).toBe(true)
    expect(
      latest.canPlay(
        { ...sender, sid: 'PA_reconnected' } as RemoteParticipant,
        'TR_voice'
      )
    ).toBe(false)
    expect(latest.canPlay(sender, 'TR_other')).toBe(false)
    act(() => latest.toggleSound())
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
  })
  it('stops local audio before a leave acknowledgement without stopping the channel', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    emit()
    mocks.fetch.mockRejectedValueOnce(new TypeError('lost leave response'))
    await act(() => latest.choose())
    expect(latest.listening).toBeUndefined()
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    expect(latest.uncertain).toBe(true)
    expect(JSON.parse(posts().at(-1)![1].body)).toMatchObject({
      operation: 'leave',
      expected_revision: 1,
    })
    expect(posts().every(([url]) => url.endsWith('subscription/'))).toBe(true)
  })
  it('recovers an ambiguous join after remount using exactly the original intent', async () => {
    const original = mocks.fetch.getMockImplementation()!
    let lost = false
    mocks.fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST' && lost)
        return { result: {}, replayed: true }
      const result = await original(url, options)
      if (options?.method === 'POST') {
        lost = true
        throw new TypeError('lost reply')
      }
      return result
    })
    const view = show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    expect(latest.uncertain).toBe(true)
    const previous = posts()[0][1].body
    view.unmount()
    client.clear()
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    expect(posts()).toHaveLength(1)
    await act(() => latest.resubmit())
    expect(posts()[1][1].body).toBe(previous)
    expect(latest.uncertain).toBe(false)
    expect(latest.listening).toBe(ids.en)
  })
  it('expires the local lease and never automatically rejoins', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    emit()
    now = 22000
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    await waitFor(() => expect(latest.listening).toBeUndefined())
    expect(latest.error).toBe(true)
    expect(posts()).toHaveLength(1)
  })
  it('rejects old language events after a subscription switch', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    emit()
    status.channels[1].state = 'translating'
    await act(() => latest.choose(status.channels[1]))
    emit({ subscription_revision: 1 })
    expect(latest.ready).toBe(false)
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    expect(JSON.parse(posts()[1][1].body)).toMatchObject({
      expected_revision: 1,
      channel_id: ids.zh,
    })
  })
  it('clears data and audio on a fresh permission error', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    emit()
    emit({
      type: 'target_final',
      text: 'Private translation',
      response_id: 'r',
      item_id: 'i',
    })
    expect(latest.rows).toHaveLength(1)
    mocks.fetch.mockRejectedValue(new ApiError(403, {}))
    await act(() =>
      client.invalidateQueries({ queryKey: ['meeting-interpretation'] })
    )
    expect(latest.rows).toHaveLength(0)
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
  })
  it('administrator channel control does not subscribe on their behalf', async () => {
    show()
    await waitFor(() => expect(latest.canControl).toBe(true))
    await act(() => latest.control('en', 'stop'))
    expect(JSON.parse(posts()[0][1].body)).toMatchObject({
      operation: 'stop',
      expected_channel_id: ids.en,
    })
    expect(latest.listening).toBeUndefined()
    expect(posts()).toHaveLength(1)
  })
  it('removes an unpublished track and fences an Agent reconnection immediately', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    await act(() => latest.choose(status.channels[0]))
    emit()
    act(() =>
      listeners
        .get(RoomEvent.TrackUnpublished)
        ?.forEach((fn) => fn({ trackSid: 'TR_voice' }))
    )
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
    emit()
    act(() =>
      listeners
        .get(RoomEvent.ParticipantDisconnected)
        ?.forEach((fn) => fn(sender))
    )
    expect(latest.listening).toBeUndefined()
    expect(latest.ready).toBe(false)
  })
  it('renews only an explicit subscription and silences on renewal failure', async () => {
    show()
    await waitFor(() => expect(latest.canJoin).toBe(true))
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    await act(() => latest.choose(status.channels[0]))
    emit()
    const original = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('renew/')) throw new ApiError(409, {})
      return original(url, options)
    })
    await act(() => vi.advanceTimersByTimeAsync(5100))
    expect(posts().filter(([url]) => url.endsWith('renew/'))).toHaveLength(1)
    expect(latest.listening).toBeUndefined()
    expect(latest.canPlay(sender, 'TR_voice')).toBe(false)
  })
})
