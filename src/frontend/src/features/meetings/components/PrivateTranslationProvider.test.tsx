import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RemoteAudioTrack,
  RoomEvent,
  type RemoteParticipant,
} from 'livekit-client'
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
  sid: string
  isAgent: boolean
  audioTrackPublications: Map<
    string,
    { track: RemoteAudioTrack; trackSid: string }
  >
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
  emit({
    type: 'ready',
    sequence: 0,
    direction: null,
    awaiting: false,
    audio_track_sid: 'TR_voice',
  })
const posts = () =>
  mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')
beforeEach(() => {
  sessionStorage.clear()
  mocks.fetch.mockReset()
  current = null
  listeners = new Map()
  track = Object.create(RemoteAudioTrack.prototype)
  track.setVolume = vi.fn()
  sender = {
    identity: 'translation-run-job',
    sid: 'PA_agent',
    isAgent: true,
    audioTrackPublications: new Map([
      ['TR_voice', { track, trackSid: 'TR_voice' }],
    ]),
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
afterEach(() => {
  client?.clear()
  vi.restoreAllMocks()
})

describe('Persistent private translation session', () => {
  it('requires the exact ready audio grant, participant connection and source connection', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    await act(async () => {
      latest.toggleSound()
    })
    const participant = sender as unknown as RemoteParticipant
    expect(latest.canPlay(participant, 'TR_voice')).toBe(false)
    // Older ready packets still restore controls but cannot authorize an unspecified track.
    emit({ type: 'ready', sequence: 0, direction: null, awaiting: false })
    expect(latest.canPlay(participant, 'TR_voice')).toBe(false)
    ready()
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(true)
    )
    expect(latest.canPlay(participant, 'TR_other')).toBe(false)
    expect(
      latest.canPlay(
        { ...participant, sid: 'PA_other' } as RemoteParticipant,
        'TR_voice'
      )
    ).toBe(false)
    expect(
      latest.canPlay(
        { ...participant, isAgent: false } as RemoteParticipant,
        'TR_voice'
      )
    ).toBe(false)
    current = { ...run(), source_participant_sid: 'PA_other_device' }
    await act(() =>
      client.invalidateQueries({ queryKey: ['meeting-translations'] })
    )
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(false)
    )
  })

  it('drops the grant across generation changes and status failures', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    await act(async () => {
      latest.toggleSound()
    })
    ready()
    const participant = sender as unknown as RemoteParticipant
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(true)
    )
    current = { ...run(), generation: 2 }
    await act(() =>
      client.invalidateQueries({ queryKey: ['meeting-translations'] })
    )
    await waitFor(() => expect(latest.current?.generation).toBe(2))
    expect(latest.canPlay(participant, 'TR_voice')).toBe(false)
    emit({
      type: 'ready',
      generation: 2,
      sequence: 0,
      direction: null,
      awaiting: false,
      audio_track_sid: 'TR_voice',
    })
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(true)
    )
    mocks.fetch.mockRejectedValue(new ApiError(403, {}))
    await act(() =>
      client.invalidateQueries({ queryKey: ['meeting-translations'] })
    )
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(false)
    )
  })

  it('expires cached audio permission even when the next status request hangs', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    await act(async () => {
      latest.toggleSound()
    })
    ready()
    const participant = sender as unknown as RemoteParticipant
    await waitFor(() =>
      expect(latest.canPlay(participant, 'TR_voice')).toBe(true)
    )
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 16000)
    await waitFor(
      () => expect(latest.canPlay(participant, 'TR_voice')).toBe(false),
      { timeout: 2500 }
    )
  })
  it('does not unmute a stopped intent when an earlier audio-unlock promise resolves late', async () => {
    current = run()
    show()
    await waitFor(() => expect(latest.current?.id).toBe('run'))
    ready()
    let unlock!: () => void
    mocks.room.startAudio.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          unlock = resolve
        })
    )
    act(() => latest.toggleSound())
    const original = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation((url, options) => {
      if (options?.method === 'POST')
        throw new TypeError('unknown stop outcome')
      return original(url, options)
    })
    await act(() => latest.change())
    await act(async () => {
      unlock()
    })
    expect(latest.muted).toBe(true)
    expect(
      latest.canPlay(sender as unknown as RemoteParticipant, 'TR_voice')
    ).toBe(false)
  })
  it('freezes the explicit archive choice in the original start intent', async () => {
    show()
    await waitFor(() => expect(latest.canStart).toBe(true))
    await act(() =>
      latest.change({ ...run().configuration, save_translations: true })
    )
    expect(JSON.parse(posts()[0][1].body)).toMatchObject({
      operation: 'start',
      save_translations: true,
    })
    await act(() => latest.change())
    expect(JSON.parse(posts()[1][1].body)).not.toHaveProperty(
      'save_translations'
    )
  })
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
  it.each([401, 403, 404, 408, 429, 503])(
    'retries an uncertain start with the original key and payload after HTTP %s',
    async (code) => {
      const original = mocks.fetch.getMockImplementation()!
      let failed = false
      mocks.fetch.mockImplementation(async (url, options) => {
        const result = await original(url, options)
        if (options?.method === 'POST' && !failed) {
          failed = true
          throw new ApiError(code, {})
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
    }
  )
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

it('restores an unknown start without dispatching or enabling audio on remount', async () => {
  const normal = mocks.fetch.getMockImplementation()!
  let fail = true
  mocks.fetch.mockImplementation(async (url, options) => {
    const result = await normal(url, options)
    if (options?.method === 'POST' && fail) throw new ApiError(503, {})
    return result
  })
  const first = show()
  await waitFor(() => expect(latest.canStart).toBe(true))
  await act(() => latest.change(run().configuration))
  await waitFor(() => expect(latest.uncertain).toBe(true))
  const original = posts()[0][1].body
  first.unmount()
  client.clear()
  mocks.room.startAudio.mockClear()
  fail = false
  show()
  await waitFor(() => expect(latest.uncertain).toBe(true))
  expect(posts()).toHaveLength(1)
  expect(latest.muted).toBe(true)
  await act(() => latest.change())
  await waitFor(() => expect(latest.uncertain).toBe(false))
  expect(posts()[1][1].body).toBe(original)
  expect(mocks.room.startAudio).not.toHaveBeenCalled()
  expect(latest.muted).toBe(true)
})

it('keeps an aborted request recoverable even if its response arrives after unmount', async () => {
  const normal = mocks.fetch.getMockImplementation()!
  let release!: (value: unknown) => void
  mocks.fetch.mockImplementation((url, options) =>
    options?.method === 'POST'
      ? new Promise((resolve) => {
          release = resolve
        })
      : normal(url, options)
  )
  const first = show()
  await waitFor(() => expect(latest.canStart).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: 'change' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  const key = sessionStorage.key(0)!
  const retained = sessionStorage.getItem(key)
  first.unmount()
  expect(posts()[0][1].signal.aborted).toBe(true)
  await act(async () => release({ current: run() }))
  expect(sessionStorage.getItem(key)).toBe(retained)
})

it('blocks a new command when its existing recovery marker is corrupt', async () => {
  const key = `meeting-summary-intent:v1:${JSON.stringify(['private-translation', 'viewer', 'room:RM_current'])}`
  sessionStorage.setItem(key, '{')
  show()
  await waitFor(() => expect(latest.error).toBe(true))
  expect(latest.canStart).toBe(false)
  await act(() => latest.change(run().configuration))
  expect(posts()).toHaveLength(0)
  expect(sessionStorage.getItem(key)).toBe('{')
})
