import { Blob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { MAX_WAV_BYTES, VoiceprintClient } from './api'
import {
  ENROLLMENT,
  KEY,
  ORG,
  OWNER,
  SAMPLE,
  enrollment,
  sample,
  settings,
} from './fixtures.test-utils'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), blob: vi.fn() }))
vi.mock('@/api/fetchApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
  fetchApiBlob: mocks.blob,
}))
beforeEach(() => {
  vi.clearAllMocks()
  setTokens({ accessToken: 'actor-a' })
})
afterEach(() => {
  vi.useRealTimers()
})

it('binds each request to the displayed account and scope without caching', async () => {
  mocks.fetch.mockResolvedValue(settings({ organization_id: ORG }))
  await new VoiceprintClient(ORG, OWNER).settings()
  const [url, options] = mocks.fetch.mock.calls[0]
  expect(url).toBe(`voiceprint/settings/?organization_id=${ORG}`)
  expect(options.cache).toBe('no-store')
  expect(options.headers['X-Voiceprint-Owner']).toBe(OWNER)
})

it('sends an upload as WAV bytes with its permit, not JSON, user ids or client quality', async () => {
  const body = new Blob([new Uint8Array(144044)], {
    type: 'audio/wav',
  }) as globalThis.Blob
  mocks.fetch.mockResolvedValue(sample({ status: 'pending' }))
  await new VoiceprintClient(null, OWNER).upload(enrollment(), 2, body)
  const [url, options] = mocks.fetch.mock.calls[0]
  expect(url).toBe(`voiceprint/enrollments/${ENROLLMENT}/clips/2/`)
  expect(options.body).toBe(body)
  expect(options.headers).toMatchObject({
    'content-type': 'audio/wav',
    'x-voiceprint-upload-token': 'x'.repeat(43),
    'X-Voiceprint-Owner': OWNER,
  })
  expect(options.headers).not.toHaveProperty('Content-Length')
})

it('does not send a deferred command under a changed login', async () => {
  const client = new VoiceprintClient(null, OWNER)
  const pending = client.change('allow_enrollment', true, 0)
  setTokens({ accessToken: 'actor-b' })
  await expect(pending).rejects.toBeInstanceOf(ApiError)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('rejects private data which arrives after the login changes', async () => {
  let finish!: (value: unknown) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = new VoiceprintClient(null, OWNER).settings()
  await Promise.resolve()
  setTokens({ accessToken: 'actor-b' })
  finish(settings())
  await expect(pending).rejects.toBeInstanceOf(ApiError)
})

it('aborts hanging requests at a total deadline, including a stuck authentication refresh', async () => {
  vi.useFakeTimers()
  mocks.fetch.mockImplementation(() => new Promise(() => undefined))
  const pending = new VoiceprintClient(null, OWNER).settings()
  const assertion = expect(pending).rejects.toThrow(
    'voiceprint_request_timeout'
  )
  await vi.advanceTimersByTimeAsync(15000)
  await assertion
  expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true)
})

it('rejects an enrollment for another scope or with unsafe PCM metadata', async () => {
  const client = new VoiceprintClient(null, OWNER)
  for (const patch of [
    { organization_id: ORG },
    { sample_rate: 48000 },
    { uploaded_slots: [6] },
    { uploaded_slots: [1, 1] },
  ]) {
    mocks.fetch.mockResolvedValue(enrollment(patch))
    await expect(client.begin(1, KEY, 'en')).rejects.toThrow(
      'voiceprint_response_invalid'
    )
  }
})

it('does not turn a quality-pending or malformed sample into a confirmable one', async () => {
  mocks.fetch.mockResolvedValue({
    results: [sample({ confirmable: true })],
    next_offset: null,
  })
  await expect(new VoiceprintClient(null, OWNER).samples()).rejects.toThrow(
    'voiceprint_response_invalid'
  )
})

it('uses the authenticated bounded blob path for private listening', async () => {
  mocks.blob.mockResolvedValue(
    new Blob([new Uint8Array(144044)], { type: 'audio/wav' })
  )
  await new VoiceprintClient(null, OWNER).audio(SAMPLE)
  expect(mocks.blob).toHaveBeenCalledWith(
    `voiceprint/samples/${SAMPLE}/audio/`,
    expect.objectContaining({
      cache: 'no-store',
      headers: { 'X-Voiceprint-Owner': OWNER },
    }),
    MAX_WAV_BYTES
  )
})

it('rejects a decision acknowledgement for a different clip', async () => {
  mocks.fetch.mockResolvedValue(
    sample({ id: KEY, status: 'confirmed', confirmable: false })
  )
  await expect(
    new VoiceprintClient(null, OWNER).decide(SAMPLE, true, 1)
  ).rejects.toThrow('voiceprint_response_invalid')
})

it('rejects backwards, empty continuing or out-of-bounds pagination', async () => {
  const client = new VoiceprintClient(null, OWNER)
  for (const page of [
    { results: [sample()], next_offset: 25 },
    { results: [sample()], next_offset: 10001 },
    { results: [], next_offset: 50 },
  ]) {
    mocks.fetch.mockResolvedValue(page)
    await expect(client.samples(25)).rejects.toThrow(
      'voiceprint_response_invalid'
    )
  }
})

it('refreshes sample metadata within its scope and verifies the item id', async () => {
  const client = new VoiceprintClient(ORG, OWNER)
  mocks.fetch.mockResolvedValue(sample())
  await client.sample(SAMPLE)
  expect(mocks.fetch.mock.calls[0][0]).toBe(
    `voiceprint/samples/${SAMPLE}/?organization_id=${ORG}`
  )
  mocks.fetch.mockResolvedValue(sample({ id: KEY }))
  await expect(client.sample(SAMPLE)).rejects.toThrow(
    'voiceprint_response_invalid'
  )
})

it('rejects invalid dates in private profile and deletion metadata', async () => {
  const client = new VoiceprintClient(null, OWNER)
  const value = settings()
  value.profiles[0].confirmed_at = 'invalid-date'
  mocks.fetch.mockResolvedValue(value)
  await expect(client.settings()).rejects.toThrow('voiceprint_response_invalid')
  mocks.fetch.mockResolvedValue({ ...value, profiles: [null] })
  await expect(client.settings()).rejects.toThrow('voiceprint_response_invalid')
  mocks.fetch.mockResolvedValue({ results: [null], next_offset: null })
  await expect(client.scopes()).rejects.toThrow('voiceprint_response_invalid')
  mocks.fetch.mockResolvedValue({
    id: KEY,
    status: 'failed',
    revoked_generation: 1,
    finished_at: 'invalid-date',
    error_code: null,
  })
  await expect(client.deletion(KEY)).rejects.toThrow(
    'voiceprint_response_invalid'
  )
})
