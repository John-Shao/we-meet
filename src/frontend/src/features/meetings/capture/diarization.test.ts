import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { DiarizationClient } from './diarization'
import { OWNER, CAPTURE, KEY, JOB, job, state } from './diarization.test-utils'
vi.mock('@/api/fetchApi', async (original) => ({
  ...(await original<typeof import('@/api/fetchApi')>()),
  fetchApi: vi.fn(),
}))
let client: DiarizationClient
beforeEach(() => {
  sessionStorage.clear()
  setTokens({ accessToken: 'synthetic' })
  client = new DiarizationClient(OWNER, CAPTURE)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  sessionStorage.clear()
})
it('binds every private read to the owner and login', async () => {
  vi.mocked(fetchApi).mockResolvedValue(state())
  await client.state(new AbortController().signal)
  expect(fetchApi).toHaveBeenCalledWith(
    client.path,
    expect.objectContaining({
      cache: 'no-store',
      headers: { 'X-Voiceprint-Owner': OWNER },
    })
  )
})
it('persists before POST, reuses an uncertain nonce after reload, and removes only acknowledged intent', async () => {
  const intent = { key: KEY, expected_revision: 1 }
  vi.mocked(fetchApi).mockImplementationOnce(async () => {
    expect(client.intent()).toEqual(intent)
    throw new Error('network')
  })
  await expect(
    client.submit(intent, new AbortController().signal)
  ).rejects.toThrow('network')
  client = new DiarizationClient(OWNER, CAPTURE)
  expect(client.intent()).toEqual(intent)
  vi.mocked(fetchApi).mockResolvedValue({ job: job(), created: false })
  await client.submit(client.intent()!, new AbortController().signal)
  const options = vi.mocked(fetchApi).mock.calls.at(-1)![1]!
  expect(options.meetingCommand).toEqual({
    key: KEY,
    scope: { capture_id: CAPTURE },
  })
  expect(JSON.parse(options.body as string)).toEqual({ expected_revision: 1 })
  expect(client.intent()).toBeUndefined()
})
it('does not acknowledge an unrelated receipt', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    job: { ...job(), source_revision: 2 },
    created: true,
  })
  await expect(
    client.submit(
      { key: KEY, expected_revision: 1 },
      new AbortController().signal
    )
  ).rejects.toThrow('response_invalid')
  expect(client.intent()?.key).toBe(KEY)
})
it('drops late results and refuses old-login writes', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(fetchApi).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const request = client.state(new AbortController().signal)
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  setTokens({ accessToken: 'another-synthetic-login' })
  resolve(state())
  await expect(request).rejects.toThrow()
  await expect(
    client.submit(
      { key: KEY, expected_revision: 1 },
      new AbortController().signal
    )
  ).rejects.toThrow('authentication_changed')
  expect(fetchApi).toHaveBeenCalledTimes(1)
})
it.each([
  { record_revision: true },
  { can_start: 'true' },
  { results: [job(), job()] },
  { active_job_id: JOB, results: [job()] },
])('rejects malformed status (%j)', async (change) => {
  vi.mocked(fetchApi).mockResolvedValue({ ...state(), ...change })
  await expect(client.state(new AbortController().signal)).rejects.toThrow(
    'response_invalid'
  )
})
it('accepts an older published pointer outside the bounded recent history', async () => {
  vi.mocked(fetchApi).mockResolvedValue({ ...state(), active_job_id: JOB })
  expect((await client.state(new AbortController().signal)).active_job_id).toBe(
    JOB
  )
})
it('rejects a cancellation receipt for another job', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    job: { ...job(), id: KEY, status: 'canceled' },
  })
  await expect(
    client.cancel(job(), 1, new AbortController().signal)
  ).rejects.toThrow('response_invalid')
})
it('never starts paid work when browser storage refuses the nonce', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied')
  })
  await expect(
    client.submit(
      { key: KEY, expected_revision: 1 },
      new AbortController().signal
    )
  ).rejects.toThrow()
  expect(fetchApi).not.toHaveBeenCalled()
})
