import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import {
  IdentificationClient,
  type IdentityResponse,
} from './identificationApi'
import {
  clearIdentityIntents,
  identityIntent,
  rememberIdentityIntent,
  acknowledgeIdentityIntent,
} from './identificationIntent'
import {
  OWNER,
  RECORD,
  SPEAKER,
  ORG,
  KEY,
  SUGGESTION,
  options,
  response,
  submission,
} from './identificationFixtures.test-utils'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: mocks.fetch,
}))
beforeEach(() => {
  vi.resetAllMocks()
  clearIdentityIntents()
  setTokens({ accessToken: 'actor' })
})
afterEach(() => vi.useRealTimers())

it('binds directory reads to the record, source revision, explicit library and displayed owner', async () => {
  mocks.fetch.mockResolvedValueOnce(options()).mockResolvedValueOnce({
    record_revision: 1,
    organization_id: null,
    results: [{ id: OWNER, name: 'Ada' }],
    next_offset: null,
  })
  const client = new IdentificationClient(RECORD, OWNER)
  await client.options(1)
  await client.candidates(null, 1, 'Ada')
  expect(mocks.fetch.mock.calls[1][0]).toContain(
    `meeting-records/${RECORD}/speaker-identification-candidates/?expected_revision=1&offset=0&organization_id=personal&q=Ada`
  )
  for (const [, init] of mocks.fetch.mock.calls)
    expect(init).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { 'X-Voiceprint-Owner': OWNER },
    })
})

it('submits only explicit IDs and returns the matching batch', async () => {
  mocks.fetch.mockResolvedValue(response(true))
  await new IdentificationClient(RECORD, OWNER).submit(submission())
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(submission())
})

it('requires server-side batch, target, scope and request-key binding', async () => {
  for (const change of [
    (value: IdentityResponse) => {
      value.request!.request_key = ORG
    },
    (value: IdentityResponse) => {
      value.request!.organization_id = ORG
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].speaker_id = ORG
    },
    (value: IdentityResponse) => {
      value.request = null
    },
  ]) {
    const value = response(true)
    change(value)
    mocks.fetch.mockResolvedValue(value)
    await expect(
      new IdentificationClient(RECORD, OWNER).submit(submission())
    ).rejects.toThrow('voiceprint_response_invalid')
  }
})

it('rejects malformed or unsafe suggestion states and audio ranges', async () => {
  for (const change of [
    (value: IdentityResponse) => {
      value.request!.processing = true
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].suggestion!.verification_unavailable = true
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].suggestion!.state = 'confirmed'
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].suggestion!.query_intervals[0].start_ms = -1
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].suggestion!.query_intervals[0].end_ms = 20000
    },
    (value: IdentityResponse) => {
      value.request!.jobs[0].suggestion!.clip_count = 1
    },
    (value: IdentityResponse) => {
      value.request!.jobs.push(value.request!.jobs[0])
    },
  ]) {
    const value = response()
    change(value)
    mocks.fetch.mockResolvedValue(value)
    await expect(
      new IdentificationClient(RECORD, OWNER).read(KEY)
    ).rejects.toThrow('voiceprint_response_invalid')
  }
})

it('does not offer another person from the personal library or a changed source revision', async () => {
  const client = new IdentificationClient(RECORD, OWNER)
  mocks.fetch.mockResolvedValue({
    record_revision: 1,
    organization_id: null,
    results: [{ id: ORG, name: 'Someone' }],
    next_offset: null,
  })
  await expect(client.candidates(null, 1)).rejects.toThrow(
    'voiceprint_response_invalid'
  )
  const value = options()
  value.record_revision = 2
  mocks.fetch.mockResolvedValue(value)
  await expect(client.options(1)).rejects.toThrow('voiceprint_response_invalid')
})

it('rejects invalid IDs, duplicate candidates, overflow and unversioned decisions before sending', async () => {
  const client = new IdentificationClient(RECORD, OWNER)
  await expect(
    client.submit({ ...submission(), user_ids: [OWNER, OWNER] })
  ).rejects.toThrow()
  await expect(
    client.submit({ ...submission(), speaker_ids: [] })
  ).rejects.toThrow()
  await expect(
    client.decide(SPEAKER, SUGGESTION, 'confirm_suggestion', 0)
  ).rejects.toThrow()
  await expect(client.candidates(null, 1, '', 10001)).rejects.toThrow()
  await expect(client.read('https://other.example')).rejects.toThrow()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('keeps confirmation and rejection free from forged identity fields', async () => {
  mocks.fetch.mockResolvedValue({
    id: SPEAKER,
    display_name: 'Ada',
    record_revision: 2,
  })
  await new IdentificationClient(RECORD, OWNER).decide(
    SPEAKER,
    SUGGESTION,
    'confirm_suggestion',
    1
  )
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
    action: 'confirm_suggestion',
    suggestion_id: SUGGESTION,
    expected_revision: 1,
  })
})

it('fences a login change before sending and after receiving a response', async () => {
  const client = new IdentificationClient(RECORD, OWNER)
  const deferred = client.options(1)
  setTokens({ accessToken: 'another' })
  await expect(deferred).rejects.toBeInstanceOf(ApiError)
  expect(mocks.fetch).not.toHaveBeenCalled()
  let complete!: (value: unknown) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const read = new IdentificationClient(RECORD, OWNER).read()
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
  setTokens({ accessToken: 'third' })
  complete(response())
  await expect(read).rejects.toBeInstanceOf(ApiError)
})

it('bounds cancellation and timeout even when transport ignores abort', async () => {
  vi.useFakeTimers()
  mocks.fetch.mockImplementation(() => new Promise(() => {}))
  const client = new IdentificationClient(RECORD, OWNER)
  const abort = new AbortController()
  const read = client.options(1, 0, abort.signal)
  const rejected = expect(read).rejects.toThrow('canceled')
  await Promise.resolve()
  abort.abort()
  await rejected
  const timeout = client.read()
  const timedOut = expect(timeout).rejects.toThrow('voiceprint_request_timeout')
  await vi.advanceTimersByTimeAsync(15001)
  await timedOut
})

it('retains an uncertain exact command across panel lifetimes and clears only its acknowledgement', () => {
  const client = new IdentificationClient(RECORD, OWNER)
  const input = submission()
  rememberIdentityIntent(client, input)
  input.user_ids.push(ORG)
  expect(identityIntent(new IdentificationClient(RECORD, OWNER))).toEqual(
    submission()
  )
  acknowledgeIdentityIntent(client, ORG)
  expect(identityIntent(client)).toBeDefined()
  acknowledgeIdentityIntent(client, KEY)
  expect(identityIntent(client)).toBeUndefined()
})

it('does not carry unacknowledged commands to a different login', () => {
  const old = new IdentificationClient(RECORD, OWNER)
  rememberIdentityIntent(old, submission())
  setTokens({ accessToken: 'new-login' })
  expect(
    identityIntent(new IdentificationClient(RECORD, OWNER))
  ).toBeUndefined()
  expect(() => identityIntent(old)).toThrow('authentication_changed')
})

it('preserves the original command when another panel attempts a different submission', () => {
  const first = new IdentificationClient(RECORD, OWNER)
  const second = new IdentificationClient(RECORD, OWNER)
  rememberIdentityIntent(first, submission())
  expect(() =>
    rememberIdentityIntent(second, { ...submission(), request_key: ORG })
  ).toThrow('voiceprint_pending_request_exists')
  expect(() =>
    rememberIdentityIntent(second, { ...submission(), expected_revision: 2 })
  ).toThrow('voiceprint_pending_request_exists')
  expect(() =>
    rememberIdentityIntent(second, { ...submission(), user_ids: [ORG] })
  ).toThrow('voiceprint_pending_request_exists')
  const snapshot = identityIntent(second)!
  snapshot.user_ids.push(ORG)
  expect(identityIntent(first)).toEqual(submission())
  expect(() => rememberIdentityIntent(second, submission())).not.toThrow()
  acknowledgeIdentityIntent(second, ORG)
  expect(identityIntent(first)).toEqual(submission())
})

it('bounds uncertain commands without evicting an older unacknowledged request', () => {
  const clients = Array.from(
    { length: 21 },
    (_, i) =>
      new IdentificationClient(
        `99999999-9999-4999-8999-${String(i + 100).padStart(12, '0')}`,
        OWNER
      )
  )
  clients
    .slice(0, 20)
    .forEach((client) => rememberIdentityIntent(client, submission()))
  expect(() => rememberIdentityIntent(clients[20], submission())).toThrow(
    'voiceprint_pending_requests_limit'
  )
  expect(identityIntent(clients[0])).toEqual(submission())
})
