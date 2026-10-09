import { Blob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { setTokens } from '@/features/auth/utils/tokenStorage'
import { VoiceprintClient } from './api'
import { VoiceprintController } from './controller'
import { pcmWav } from './recording'
import {
  ENROLLMENT,
  OWNER,
  SAMPLE,
  enrollment,
  sample,
  settings,
} from './fixtures.test-utils'

let controllers: VoiceprintController[]
beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('Blob', Blob)
  setTokens({ accessToken: 'actor-a' })
  controllers = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => {
  controllers.forEach((c) => c.dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup() {
  const client = new VoiceprintClient(null, OWNER)
  const state = settings(),
    registration = enrollment(),
    clip = sample()
  vi.spyOn(client, 'settings').mockImplementation(async () => ({ ...state }))
  vi.spyOn(client, 'samples').mockImplementation(async () => ({
    results: [clip],
    next_offset: null,
  }))
  vi.spyOn(client, 'deletions').mockResolvedValue({
    results: [],
    next_offset: null,
  })
  vi.spyOn(client, 'begin').mockImplementation(async () => ({
    ...registration,
  }))
  vi.spyOn(client, 'enrollment').mockImplementation(async () => ({
    ...registration,
  }))
  vi.spyOn(client, 'audio').mockResolvedValue(
    pcmWav(new Float32Array(24000 * 3))
  )
  vi.spyOn(client, 'upload').mockResolvedValue(clip)
  vi.spyOn(client, 'decide').mockResolvedValue(sample({ status: 'confirmed' }))
  const controller = new VoiceprintController(client)
  controllers.push(controller)
  return { client, controller, state, registration, clip }
}

it('does not create a registration or request a microphone while loading settings', async () => {
  const { controller, client } = setup()
  await controller.refresh()
  expect(controller.getSnapshot().settings?.allow_identification).toBe(false)
  expect(client.begin).not.toHaveBeenCalled()
})

it('keeps quality-pending clips unconfirmable even after private listening', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  controller.listened(clip.id)
  controller.confirmSelf(clip.id, true)
  await controller.decide(clip, true)
  expect(client.decide).not.toHaveBeenCalled()
  expect(controller.getSnapshot().samples[0].status).toBe('quality_pending')
})

it('requires both finished listening and explicit self confirmation for a ready clip', async () => {
  const { controller, client, clip } = setup()
  clip.status = 'ready'
  clip.confirmable = true
  await controller.refresh()
  await controller.preview(clip)
  await controller.decide(clip, true)
  expect(client.decide).not.toHaveBeenCalled()
  controller.confirmSelf(clip.id, true)
  await controller.decide(clip, true)
  expect(client.decide).not.toHaveBeenCalled()
  controller.listened(clip.id)
  await controller.decide(clip, true)
  expect(client.decide).toHaveBeenCalledWith(
    SAMPLE,
    true,
    1,
    expect.any(AbortSignal)
  )
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-fixture')
})

it('fences conflict retries until explicit reload and clears private media', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  vi.spyOn(client, 'change').mockRejectedValue(
    new ApiError(409, { code: 'voiceprint_settings_changed' })
  )
  await controller.change('allow_identification', true)
  expect(controller.getSnapshot().conflict).toBe(true)
  expect(controller.getSnapshot().preview).toBeUndefined()
  await controller.change('allow_identification', true)
  expect(client.change).toHaveBeenCalledTimes(1)
  await controller.refresh(true)
  expect(controller.getSnapshot().conflict).toBe(false)
})

it('revokes local audio when a permission version changes on another client', async () => {
  const { controller, state, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  state.version = 2
  state.allow_identification = true
  await controller.refresh()
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('discards late audio and all private state after changing accounts', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  let resolve!: (blob: globalThis.Blob) => void
  vi.mocked(client.audio).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const pending = controller.preview(clip)
  setTokens({ accessToken: 'actor-b' })
  controller.tick()
  resolve(pcmWav(new Float32Array(24000 * 3)))
  await pending
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(controller.getSnapshot().settings).toBeUndefined()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('retries an unknown registration response with exactly the original request key', async () => {
  const { controller, client } = setup()
  await controller.refresh()
  vi.mocked(client.begin).mockRejectedValueOnce(new TypeError('network'))
  await controller.begin('en')
  await controller.begin('en')
  expect(vi.mocked(client.begin).mock.calls[0][1]).toBe(
    vi.mocked(client.begin).mock.calls[1][1]
  )
  expect(controller.getSnapshot().enrollment?.id).toBe(ENROLLMENT)
})

it('keeps the original token, WAV and slot when the final upload succeeded but its response was lost', async () => {
  const { controller, client, registration } = setup()
  registration.uploaded_slots = [0, 1, 2, 3, 4]
  await controller.refresh()
  await controller.begin('en')
  const wav = pcmWav(new Float32Array(24000 * 3))
  await controller.file(wav)
  vi.mocked(client.upload).mockRejectedValueOnce(new TypeError('response lost'))
  await controller.upload()
  registration.uploaded_slots = [0, 1, 2, 3, 4, 5]
  registration.status = 'closed'
  registration.upload_token = null
  await controller.refresh()
  expect(controller.canRecord()).toBe(false)
  expect(controller.canUpload()).toBe(true)
  await controller.upload()
  const calls = vi.mocked(client.upload).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1][0].upload_token).toBe('x'.repeat(43))
  expect(calls[1][1]).toBe(5)
  expect(calls[1][2]).toBe(wav)
  expect(controller.getSnapshot().clip).toBeUndefined()
})

it('expires cached audio and registration grants without waiting for another HTTP poll', async () => {
  const { controller, clip } = setup()
  await controller.refresh()
  await controller.begin('en')
  await controller.preview(clip)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 700000)
  controller.tick()
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(controller.getSnapshot().enrollment).toBeUndefined()
})

it('requires a concrete delete target and reuses its idempotency key after a lost response', async () => {
  const { controller, client } = setup()
  const remove = vi
    .spyOn(client, 'remove')
    .mockRejectedValue(new TypeError('network'))
  await controller.refresh()
  await controller.remove()
  expect(remove).not.toHaveBeenCalled()
  controller.requestRemoval(settings().profiles[0].id)
  await controller.remove()
  await controller.remove()
  expect(remove.mock.calls[0][2]).toBe(remove.mock.calls[1][2])
})

it('does not pile up polling requests while a settings read is slow', async () => {
  const { controller, client } = setup()
  let finish!: (value: ReturnType<typeof settings>) => void
  vi.mocked(client.settings).mockImplementation(
    () =>
      new Promise((r) => {
        finish = r
      })
  )
  const first = controller.refresh()
  await controller.refresh()
  await controller.refresh()
  expect(client.settings).toHaveBeenCalledTimes(1)
  finish(settings())
  await first
})

it('keeps older pages across polls, deduplicates shifted pages and revokes remotely deleted preview audio', async () => {
  const { controller, client, clip } = setup()
  const older = sample({ id: ENROLLMENT })
  vi.mocked(client.samples).mockImplementation(async (offset = 0) => ({
    results: offset ? [clip, older] : [clip],
    next_offset: offset ? null : 25,
  }))
  const detail = vi
    .spyOn(client, 'sample')
    .mockResolvedValue({ ...older, audio_available: false })
  await controller.refresh()
  await controller.more('samples')
  expect(controller.getSnapshot().samples.map((row) => row.id)).toEqual([
    clip.id,
    older.id,
  ])
  await controller.preview(older)
  await controller.refresh()
  expect(detail).toHaveBeenCalledWith(older.id, expect.any(AbortSignal))
  expect(controller.getSnapshot().samples).toHaveLength(2)
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('revokes a preview which disappears from the refreshed first page', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  vi.mocked(client.samples).mockResolvedValue({
    results: [],
    next_offset: null,
  })
  await controller.refresh()
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('drops previous private audio immediately when a new preview request is rejected', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  vi.mocked(client.audio).mockRejectedValue(
    new ApiError(410, { code: 'voiceprint_audio_unavailable' })
  )
  await controller.preview(clip)
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('releases cached private playback when a permission heartbeat fails', async () => {
  const { controller, client, clip } = setup()
  await controller.refresh()
  await controller.preview(clip)
  vi.mocked(client.settings).mockRejectedValue(new TypeError('network offline'))
  await controller.refresh()
  expect(controller.getSnapshot().preview).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})

it('rejects an older-page response from a different profile', async () => {
  const { controller, client } = setup()
  vi.mocked(client.samples)
    .mockResolvedValueOnce({ results: [], next_offset: 25 })
    .mockResolvedValueOnce({
      results: [sample({ profile_id: ENROLLMENT })],
      next_offset: null,
    })
  await controller.refresh()
  await controller.more('samples')
  expect(controller.getSnapshot().conflict).toBe(true)
  expect(controller.getSnapshot().samples).toEqual([])
})

it('refreshes permissions before loading more samples after a generation change', async () => {
  const { controller, client, state } = setup()
  vi.mocked(client.samples).mockResolvedValue({ results: [], next_offset: 25 })
  await controller.refresh()
  state.version = 2
  state.generation = 2
  state.profiles = []
  await controller.more('samples')
  expect(controller.getSnapshot().settings?.generation).toBe(2)
  expect(
    vi.mocked(client.samples).mock.calls.every(([offset]) => offset === 0)
  ).toBe(true)
})
