import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteAudioTrack, RoomEvent } from 'livekit-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import {
  usePrivateTranslation,
  type PrivateTranslationState,
} from '../translationContext'
import { PrivateTranslationProvider } from './PrivateTranslationProvider'
import type { TranslationRun } from '../translationEvents'

type Listener = (...args: unknown[]) => void
interface Sender {
  identity: string
  isAgent: boolean
  audioTrackPublications: Map<string, { track: RemoteAudioTrack }>
}
interface RoomDouble {
  localParticipant: { sid: string; publishData: ReturnType<typeof vi.fn> }
  remoteParticipants: Map<string, Sender>
  startAudio: ReturnType<typeof vi.fn>
  on: (event: string, fn: Listener) => void
  off: (event: string, fn: Listener) => void
}
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), room: {} as RoomDouble }))
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

let client: QueryClient
let latest: PrivateTranslationState
let current: TranslationRun | null
let track: RemoteAudioTrack
let sender: Sender
let listeners: Map<string, Set<Listener>>
const run = (): TranslationRun => ({
  id: 'run',
  generation: 1,
  state: 'translating',
  source_participant_sid: 'PA_self',
  configuration: {
    source: 'zh',
    target: 'en',
    mode: 'push_to_talk',
    audio: true,
  },
})
function Probe() {
  latest = usePrivateTranslation()!
  return (
    <>
      <button onClick={() => void latest.change(run().configuration)}>
        change
      </button>
      <span>{latest.ready ? 'ready' : 'waiting'}</span>
      <span>{latest.uncertain ? 'uncertain' : 'confirmed'}</span>
      {latest.rows.map((row) => (
        <span key={row.id}>{row.text}</span>
      ))}
    </>
  )
}
function show() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PrivateTranslationProvider>
        <Probe />
      </PrivateTranslationProvider>
    </QueryClientProvider>
  )
}
const emit = (event: object, participant = sender) =>
  act(() => {
    const body = new TextEncoder().encode(
      JSON.stringify({ run_id: 'run', generation: 1, ...event })
    )
    listeners
      .get(RoomEvent.DataReceived)
      ?.forEach((fn) =>
        fn(body, participant, undefined, 'meeting.translation.events')
      )
  })
const ready = () =>
  emit({ type: 'ready', sequence: 0, direction: null, awaiting: false })
const posts = () =>
  mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
beforeEach(() => {
  mocks.fetch.mockReset()
  current = null
  listeners = new Map()
  track = Object.create(RemoteAudioTrack.prototype)
  track.setVolume = vi.fn()
  sender = {
    identity: 'translation-run-job',
    isAgent: true,
    audioTrackPublications: new Map([['TR_voice', { track }]]),
  }
  mocks.room = {
    localParticipant: {
      sid: 'PA_self',
      publishData: vi.fn().mockResolvedValue(undefined),
    },
    remoteParticipants: new Map([['agent', sender]]),
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: (event: string, fn: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    off: (event: string, fn: Listener) => listeners.get(event)?.delete(fn),
  }
  mocks.fetch.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      current =
        JSON.parse(options.body).operation === 'start'
          ? run()
          : { ...run(), state: 'stopping' }
      return { current }
    }
    return {
      available: true,
      current,
      sources: [{ id: 'source', participant_sid: 'PA_self' }],
    }
  })
})
afterEach(() => client?.clear())

describe('Persistent private translation session', () => {
  it('starts explicitly and silences audio before stop acknowledgement', async () => {
    show()
    await waitFor(() => expect(latest.canStart).toBe(true))
    expect(posts()).toHaveLength(0)
    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(latest.current?.state).toBe('translating'))
    ready()
    await screen.findByText('ready')
    await waitFor(() => expect(track.setVolume).toHaveBeenLastCalledWith(1))
    fireEvent.click(screen.getByText('change'))
    expect(track.setVolume).toHaveBeenLastCalledWith(0)
    await waitFor(() => expect(latest.current?.state).toBe('stopping'))
    expect(JSON.parse(posts()[1][1].body)).toMatchObject({
      expected_run_id: 'run',
      operation: 'stop',
    })
  })
  it('retries an uncertain start with the original key and payload', async () => {
    const original = mocks.fetch.getMockImplementation()!
    let failed = false
    mocks.fetch.mockImplementation(async (url, options) => {
      const result = await original(url, options)
      if (options?.method === 'POST' && !failed) {
        failed = true
        throw new TypeError('lost reply')
      }
      return result
    })
    show()
    await waitFor(() => expect(latest.canStart).toBe(true))
    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(latest.error && !latest.pending).toBe(true))
    expect(latest.uncertain).toBe(true)
    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[0][1].body).toEqual(posts()[1][1].body)
  })
  it('rejects stale or non-agent text and orders private manual commands', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    ready()
    const event = {
      type: 'target_final',
      direction: 'forward',
      item_id: 'i',
      response_id: 'r',
      text: 'private words',
    }
    emit({ ...event, generation: 2 })
    emit(event, { ...sender, isAgent: false })
    expect(latest.rows).toHaveLength(0)
    emit(event)
    expect(latest.rows).toHaveLength(1)
    act(() => {
      latest.press('forward', true)
      latest.press('forward', false)
      latest.press('reverse', true)
    })
    await waitFor(() =>
      expect(
        mocks.room.localParticipant.publishData.mock.calls.filter(
          ([payload]) => JSON.parse(new TextDecoder().decode(payload)).sequence
        ).length
      ).toBe(2)
    )
    const calls = mocks.room.localParticipant.publishData.mock.calls.filter(
      ([payload]) => JSON.parse(new TextDecoder().decode(payload)).sequence
    )
    expect(
      calls.map(
        ([payload]) => JSON.parse(new TextDecoder().decode(payload)).sequence
      )
    ).toEqual([1, 2])
    expect(calls[0][1].destinationIdentities).toEqual(['translation-run-job'])
  })
  it('still permits an explicit stop after a status service failure', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST')
        return { current: { ...run(), state: 'stopping' } }
      throw new ApiError(503, {})
    })
    await act(() =>
      client.invalidateQueries({ queryKey: ['meeting-translations'] })
    )
    await waitFor(() => expect(latest.error).toBe(true))
    fireEvent.click(screen.getByText('change'))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(posts()[0][1].body).operation).toBe('stop')
  })
})
