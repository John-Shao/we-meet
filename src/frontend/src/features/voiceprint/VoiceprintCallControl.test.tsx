import { EventEmitter } from 'node:events'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { ConnectionState, RoomEvent } from 'livekit-client'
import en from '@/locales/en/voiceprint.json'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { VoiceprintCallControl } from './VoiceprintCallControl'
import {
  activeConnection,
  connection,
  OWNER,
  ORG,
  ROOM,
  PARTICIPANT,
} from './callSampling.test-utils'
import { settings } from './fixtures.test-utils'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  loggedIn: true,
  microphoneEnabled: true,
  config: { speaker_identity: { enabled: true, sampling_enabled: true } },
  room: undefined as unknown,
  state: 'connected',
  roomSid: 'RM_synthetic',
  participantSid: 'PA_synthetic',
  track: undefined as unknown,
}))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: OWNER }, isLoggedIn: mocks.loggedIn }),
}))
vi.mock('@/api/useConfig', () => ({
  useConfig: () => ({ data: mocks.config }),
}))
vi.mock('@/features/meetings/useConnectedMeetingSid', () => ({
  useConnectedMeetingSid: () => mocks.roomSid,
}))
vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => mocks.room,
  useConnectionState: () => mocks.state,
  useLocalParticipant: () => ({
    localParticipant: {
      sid: mocks.participantSid,
      identity: 'synthetic-owner',
    },
    microphoneTrack: { track: mocks.track },
    isMicrophoneEnabled: mocks.microphoneEnabled,
  }),
}))
vi.mock('./VoiceprintSettingsPanel', () => ({
  VoiceprintSettingsPanel: ({
    initialOrganizationId,
    initialOrganizationName,
  }: {
    initialOrganizationId: string
    initialOrganizationName: string
  }) => <p>{`settings:${initialOrganizationId}:${initialOrganizationName}`}</p>,
}))
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
}))
const i18n = createInstance()
let value: ReturnType<typeof connection>, room: EventEmitter
beforeEach(async () => {
  vi.clearAllMocks()
  setTokens({ accessToken: 'synthetic-login' })
  mocks.loggedIn = true
  mocks.microphoneEnabled = true
  mocks.config = { speaker_identity: { enabled: true, sampling_enabled: true } }
  mocks.state = ConnectionState.Connected
  mocks.roomSid = ROOM
  mocks.participantSid = PARTICIPANT
  mocks.track = undefined
  room = new EventEmitter()
  mocks.room = room
  value = connection()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { voiceprint: en } },
    react: { useSuspense: false },
  })
  mocks.fetch.mockImplementation(
    async (path: string, options?: RequestInit) => {
      if (path.startsWith('voiceprint/sampling-connection/')) {
        value.observed_at = new Date().toISOString()
        if (value.control.runtime.state === 'sampling')
          value.control.runtime.updated_at = value.observed_at
        return structuredClone(value)
      }
      if (path === 'voiceprint/sampling-control/') {
        const changes = JSON.parse(String(options?.body))
        Object.assign(value.control, {
          paused: changes.paused,
          shared_microphone: changes.shared_microphone,
          device_group: changes.device_group,
        })
        value.control.revision++
        value.control.state = changes.paused ? 'paused' : 'ready'
        value.control.runtime = {
          state: changes.paused ? 'stopped' : 'waiting',
          reason: '',
          updated_at: null,
        }
        return structuredClone(value.control)
      }
      if (path.startsWith('voiceprint/settings/')) {
        value.permission.allow_accumulation = false
        value.permission.version++
        value.control.state = 'authorization_required'
        value.control.runtime = {
          state: 'stopped',
          reason: 'authorization_required',
          updated_at: null,
        }
        return settings({
          organization_id: value.organization_id,
          version: value.permission.version,
          allow_accumulation: false,
        })
      }
      throw new Error('unexpected fixture route')
    }
  )
})
afterEach(() => vi.restoreAllMocks())
const writes = () =>
  mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')
const show = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintCallControl />
      </StrictMode>
    </I18nextProvider>
  )
async function open() {
  show()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: en.call.open }))
  await screen.findByRole('switch', { name: en.call.shared })
}

it.each([
  'sampling-disabled',
  'identity-disabled',
  'anonymous',
  'disconnected',
])('does not query or render for %s', async (kind) => {
  if (kind === 'sampling-disabled')
    mocks.config.speaker_identity.sampling_enabled = false
  if (kind === 'identity-disabled')
    mocks.config.speaker_identity.enabled = false
  if (kind === 'anonymous') mocks.loggedIn = false
  if (kind === 'disconnected') mocks.state = ConnectionState.Disconnected
  show()
  expect(
    screen.queryByRole('button', { name: en.call.open })
  ).not.toBeInTheDocument()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('defaults to shared and paused, displays limits, and makes no implicit write in StrictMode', async () => {
  await open()
  expect(screen.getByRole('switch', { name: en.call.shared })).toBeChecked()
  expect(screen.getByRole('button', { name: en.call.resume })).toBeDisabled()
  expect(
    screen.getByText(
      /10 seconds per clip, 60 seconds per session and 120 seconds/
    )
  ).toBeInTheDocument()
  expect(writes()).toEqual([])
})

it('keeps device selection as a draft and requires separate save and allow actions', async () => {
  await open()
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(en.call.device) })
  )
  await userEvent.click(
    await screen.findByRole('option', { name: en.deviceGroup.headset })
  )
  expect(writes()).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: en.call.saveDevice }))
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({
    paused: true,
    shared_microphone: true,
    device_group: 'headset',
  })
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: en.call.shared })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('switch', { name: en.call.shared }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: en.call.resume })).toBeEnabled()
  )
  expect(JSON.parse(writes()[1][1].body)).toMatchObject({
    paused: true,
    shared_microphone: false,
  })
  fireEvent.click(screen.getByRole('button', { name: en.call.resume }))
  await waitFor(() => expect(writes()).toHaveLength(3))
  expect(JSON.parse(writes()[2][1].body)).toMatchObject({
    paused: false,
    shared_microphone: false,
    device_group: 'headset',
  })
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(en.call.phase.waiting)
  )
})

it('pauses explicitly and shows a local mute rather than positive capture', async () => {
  value = activeConnection()
  mocks.microphoneEnabled = false
  await open()
  expect(screen.getByRole('status')).toHaveTextContent(en.call.phase.muted)
  fireEvent.click(screen.getByRole('button', { name: en.call.pause }))
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body).paused).toBe(true)
})

it('turns off accumulation only for this call scope and opens that scope in settings', async () => {
  value.organization_id = ORG
  value.organization_name = 'Trusted Org'
  await open()
  fireEvent.click(screen.getByRole('button', { name: en.call.settings }))
  expect(
    await screen.findByText(`settings:${ORG}:Trusted Org`)
  ).toBeInTheDocument()
  fireEvent.keyDown(screen.getAllByRole('dialog').at(-1)!, {
    key: 'Escape',
    code: 'Escape',
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: 'Disable future call sampling in Trusted Org',
      })
    ).toBeEnabled()
  )
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Disable future call sampling in Trusted Org',
    })
  )
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body)).toEqual({
    organization_id: ORG,
    expected_version: 3,
    allow_accumulation: false,
  })
})

it('a microphone device event clears the declaration but camera and speaker events do not', async () => {
  value = activeConnection()
  await open()
  act(() => {
    room.emit(RoomEvent.ActiveDeviceChanged, 'videoinput', 'private-camera')
    room.emit(RoomEvent.ActiveDeviceChanged, 'audiooutput', 'private-speaker')
  })
  expect(writes()).toEqual([])
  act(() => {
    room.emit(RoomEvent.ActiveDeviceChanged, 'audioinput', 'private-microphone')
  })
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({
    paused: true,
    shared_microphone: true,
    device_group: '',
  })
  expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain(
    'private-microphone'
  )
})

it('unmounts the old dialog and requires a declaration again after reconnect', async () => {
  value = activeConnection()
  const view = show()
  fireEvent.click(screen.getByRole('button', { name: en.call.open }))
  await screen.findByRole('switch', { name: en.call.shared })
  mocks.state = ConnectionState.Reconnecting
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintCallControl />
      </StrictMode>
    </I18nextProvider>
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  mocks.state = ConnectionState.Connected
  act(() => {
    room.emit(RoomEvent.Reconnected)
  })
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintCallControl />
      </StrictMode>
    </I18nextProvider>
  )
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({
    paused: true,
    shared_microphone: true,
    device_group: '',
  })
})

it('shows mixed-speaker recovery guidance without resuming automatically', async () => {
  value.control.stop_reason = 'mixed_speaker'
  await open()
  expect(screen.getByRole('alert')).toHaveTextContent(en.call.mixedSpeaker)
  expect(writes()).toEqual([])
})

it('requires a fresh declaration when the microphone track is replaced without a device ID', async () => {
  value = activeConnection()
  const track = () =>
    Object.assign(new EventEmitter(), {
      mediaStreamTrack: { getSettings: () => ({}) },
    })
  mocks.track = track()
  const view = show()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
  expect(writes()).toEqual([])
  mocks.track = track()
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <VoiceprintCallControl />
      </StrictMode>
    </I18nextProvider>
  )
  await waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({
    paused: true,
    shared_microphone: true,
    device_group: '',
  })
})
