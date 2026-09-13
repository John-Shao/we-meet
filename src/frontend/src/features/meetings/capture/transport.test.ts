import { beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import type { LocalCapture } from './journal'
import { captureTransport, textAudioAvailable } from './transport'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
const id = '10000000-0000-4000-8000-000000000001'
const local = {
  id: 'local',
  createKey: id,
  create: { device_id: 'device', lease_key: id, retention_mode: 'text' },
} as LocalCapture
const capture = () => ({
  id,
  record_id: '20000000-0000-4000-8000-000000000001',
  device_id: 'device',
  audio_retention: {
    mode: 'text',
    temporary_until: '2030-01-01T10:00:00Z',
    retry_until: '2030-01-01T09:30:00Z',
    expired: false,
    cleanup_status: 'not_started',
    cleanup_error: '',
    deleted_at: null,
  },
})
beforeEach(() => vi.clearAllMocks())

it.each([
  {},
  { text_audio_available: 'true', text_audio_error: '' },
  { text_audio_available: true, text_audio_error: 'storage_unavailable' },
])(
  'does not infer text-audio capability from malformed admission %j',
  async (value) => {
    vi.mocked(fetchApi).mockResolvedValue(value)
    expect(await textAudioAvailable(new AbortController().signal)).toBe(false)
  }
)

it('uses authenticated uncached preflight with redirect rejection', async () => {
  vi.mocked(fetchApi).mockResolvedValue({
    text_audio_available: true,
    text_audio_error: '',
  })
  expect(await textAudioAvailable(new AbortController().signal)).toBe(true)
  expect(vi.mocked(fetchApi).mock.calls[0][1]).toMatchObject({
    cache: 'no-store',
    redirect: 'error',
  })
})

it('rejects another capture or missing retention in a success receipt without changing intent', async () => {
  const transport = captureTransport(new AbortController().signal)
  vi.mocked(fetchApi).mockResolvedValue({
    operation_id: id,
    replayed: false,
    capture: capture(),
    result: { ...capture(), id: crypto.randomUUID() },
  })
  await expect(transport.create(local)).rejects.toThrow(
    'invalid_text_capture_receipt'
  )
  vi.mocked(fetchApi).mockResolvedValue({
    operation_id: id,
    replayed: false,
    capture: { ...capture(), audio_retention: undefined },
    result: capture(),
  })
  await expect(transport.create(local)).rejects.toThrow('invalid_text_capture')
  const requests = vi.mocked(fetchApi).mock.calls
  expect(requests[0][1]!.body).toBe(requests[1][1]!.body)
  expect(requests[0][1]!.headers).toEqual(requests[1][1]!.headers)
})

it('accepts a validated historical text capture receipt for the original scope', async () => {
  const response = {
    operation_id: id,
    replayed: true,
    capture: capture(),
    result: capture(),
  }
  vi.mocked(fetchApi).mockResolvedValue(response)
  expect(
    await captureTransport(new AbortController().signal).create(local)
  ).toEqual(response)
})
