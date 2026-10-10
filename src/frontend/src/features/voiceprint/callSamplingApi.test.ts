import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { CallSamplingClient } from './callSamplingApi'
import {
  connection,
  activeConnection,
  OWNER,
  ORG,
  ROOM,
  PARTICIPANT,
} from './callSampling.test-utils'
import { settings } from './fixtures.test-utils'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
}))
beforeEach(() => {
  vi.clearAllMocks()
  setTokens({ accessToken: 'synthetic-login' })
})
afterEach(() => vi.useRealTimers())

it('reads only the exact connected owner and RTC SIDs, with no writes, token or media', async () => {
  mocks.fetch.mockResolvedValue(connection())
  await new CallSamplingClient(OWNER, ROOM, PARTICIPANT).read()
  expect(mocks.fetch).toHaveBeenCalledOnce()
  const [path, options] = mocks.fetch.mock.calls[0]
  expect(path).toBe(
    `voiceprint/sampling-connection/?room_sid=${ROOM}&participant_sid=${PARTICIPANT}`
  )
  expect(options).toMatchObject({
    cache: 'no-store',
    headers: { 'X-Voiceprint-Owner': OWNER },
  })
  expect(options.body).toBeUndefined()
  expect(options.method).toBeUndefined()
})

it.each([
  'room',
  'participant',
  'limit',
  'date',
  'ready',
  'proof',
  'permission',
  'retention',
])(
  'rejects inconsistent %s projection before displaying sampling',
  async (kind) => {
    const value = activeConnection()
    if (kind === 'room') value.room_sid = 'RM_other'
    if (kind === 'participant') value.control.participant_sid = 'PA_other'
    if (kind === 'limit') value.limits.daily_ms = 120001
    if (kind === 'date') value.observed_at = 'not-a-date'
    if (kind === 'ready') value.control.shared_microphone = true
    if (kind === 'proof')
      value.control.runtime.updated_at = new Date(
        Date.parse(value.observed_at) - 5000
      ).toISOString()
    if (kind === 'permission') value.permission.allow_accumulation = false
    if (kind === 'retention') value.limits.candidate_retention_seconds = 86401
    mocks.fetch.mockResolvedValue(value)
    await expect(
      new CallSamplingClient(OWNER, ROOM, PARTICIPANT).read()
    ).rejects.toThrow('voiceprint_sampling_response_invalid')
  }
)

it('pins the trusted session and scope across reads and mutations', async () => {
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  const value = connection()
  mocks.fetch.mockResolvedValue(value)
  await client.read()
  mocks.fetch.mockResolvedValue({
    ...value,
    organization_id: ORG,
    organization_name: 'Other',
  })
  await expect(client.read()).rejects.toThrow(
    'voiceprint_sampling_response_invalid'
  )
  const before = mocks.fetch.mock.calls.length
  await expect(
    client.disableAccumulation({ ...value, organization_id: ORG })
  ).rejects.toThrow()
  await expect(
    client.declare(
      { ...value, room_sid: 'RM_other' },
      { paused: false, shared_microphone: false, device_group: 'headset' }
    )
  ).rejects.toThrow()
  expect(mocks.fetch).toHaveBeenCalledTimes(before)
})

it('declares only fixed fields and the current revision, never retries a lost acknowledgement', async () => {
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  mocks.fetch.mockResolvedValueOnce(connection())
  const value = await client.read()
  mocks.fetch.mockRejectedValueOnce(new Error('lost acknowledgement'))
  await expect(
    client.declare(value, {
      paused: true,
      shared_microphone: false,
      device_group: 'headset',
      ...{ raw_device_id: 'private' },
    })
  ).rejects.toThrow('lost acknowledgement')
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
    session_id: value.control.session_id,
    participant_sid: PARTICIPANT,
    expected_revision: 0,
    paused: true,
    shared_microphone: false,
    device_group: 'headset',
  })
})

it('turns off only accumulation in the trusted organization and permission version', async () => {
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  const value = {
    ...connection(),
    organization_id: ORG,
    organization_name: 'Trusted organization',
  }
  mocks.fetch
    .mockResolvedValueOnce(value)
    .mockResolvedValueOnce(
      settings({ organization_id: ORG, version: 4, allow_accumulation: false })
    )
  await client.disableAccumulation(await client.read())
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
    organization_id: ORG,
    expected_version: 3,
    allow_accumulation: false,
  })
})

it('rejects late private data and sends no command after an account replacement', async () => {
  const client = new CallSamplingClient(OWNER, ROOM, PARTICIPANT)
  let finish!: (value: unknown) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = client.read()
  await Promise.resolve()
  setTokens({ accessToken: 'other-login' })
  finish(connection())
  await expect(pending).rejects.toBeInstanceOf(ApiError)
  await expect(client.read()).rejects.toBeInstanceOf(ApiError)
  expect(mocks.fetch).toHaveBeenCalledOnce()
})

it('ends a stalled request at the private request deadline', async () => {
  vi.useFakeTimers()
  mocks.fetch.mockImplementation(() => new Promise(() => {}))
  const pending = new CallSamplingClient(OWNER, ROOM, PARTICIPANT).read()
  const assertion = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(15000)
  await assertion
})
