import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import {
  captureTranslationApi,
  isCaptureTranslationPayload,
  isConfiguration,
  isTranslationReceipt,
  isTranslationState,
  isTranslationTicket,
} from './translationProtocol'

import { source, run, state, payload, ticket } from './translation.testFixtures'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
describe('capture translation protocol', () => {
  afterEach(() => vi.resetAllMocks())
  const intent = () => ({
    key: '66666666-6666-4666-8666-666666666666',
    payload: payload(),
  })
  const receipt = () => ({
    command: { ...intent(), capture_id: source.captureId, result: run() },
    current: state(),
    replayed: false,
  })

  it('accepts frozen original receipt with newer terminal state', () => {
    const value = receipt()
    value.current = state({
      ...run(),
      status: 'incomplete',
      ended_at: new Date().toISOString(),
    })
    expect(isTranslationReceipt(value, source, intent())).toBe(true)
    value.command.result.status = 'translating'
    expect(isTranslationReceipt(value, source, intent())).toBe(false)
  })
  it('rejects changed consent, keys and wrong capture despite HTTP success', () => {
    for (const patch of [
      { key: source.viewerId },
      { capture_id: source.recordId },
      {
        payload: {
          ...payload(),
          configuration: { ...payload().configuration!, audio: true },
        },
      },
    ]) {
      const value = receipt()
      Object.assign(value.command, patch)
      expect(isTranslationReceipt(value, source, intent())).toBe(false)
    }
  })
  it('requires explicit nullable CAS and strips no unexpected secret fields', () => {
    expect(isCaptureTranslationPayload(payload(), 'web')).toBe(true)
    expect(
      isCaptureTranslationPayload(
        { ...payload(), lease_key: source.leaseKey },
        'web'
      )
    ).toBe(false)
    expect(
      isCaptureTranslationPayload(
        { ...payload(), expected_run_id: undefined },
        'web'
      )
    ).toBe(false)
    expect(
      isCaptureTranslationPayload({ ...payload(), device_id: 'other' }, 'web')
    ).toBe(false)
    expect(
      isConfiguration({ ...run().configuration, source_language: ['zh'] })
    ).toBe(false)
    expect(isConfiguration({ ...run().configuration, audio: 'false' })).toBe(
      false
    )
  })
  it('rejects source revision and unsafe capabilities', () => {
    expect(isTranslationState(state(), source)).toBe(true)
    expect(isTranslationState({ ...state(), can_start: true }, source)).toBe(
      false
    )
    expect(
      isTranslationState(
        { ...state(), source: { ...state().source, revision: 3 } },
        source
      )
    ).toBe(false)
    expect(
      isTranslationState(
        {
          ...state(),
          source: { ...state().source, record_id: source.captureId },
        },
        source
      )
    ).toBe(false)
  })
  it('requires expiring exact-account WSS tickets outside URLs', () => {
    expect(isTranslationTicket(ticket(), source, run())).toBe(true)
    for (const url of [
      'ws://gateway.invalid/capture-translation',
      'wss://u:p@gateway.invalid/capture-translation',
      'wss://gateway.invalid/capture-translation?token=x',
      'wss://gateway.invalid/other',
    ]) {
      expect(
        isTranslationTicket({ ...ticket(), gateway_url: url }, source, run())
      ).toBe(false)
    }
    expect(
      isTranslationTicket(
        {
          ...ticket(),
          source: { ...ticket().source, user_id: source.recordId },
        },
        source,
        run()
      )
    ).toBe(false)
    expect(
      isTranslationTicket(
        { ...ticket(), expires_at: new Date(0).toISOString() },
        source,
        run()
      )
    ).toBe(false)
  })
  it('uses no-store bounded requests and only the device-lease header', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(receipt())
    const api = captureTranslationApi(
      source,
      () => true,
      new AbortController().signal
    )
    await api.control(intent())
    expect(fetchApi).toHaveBeenCalledWith(
      `capture-sessions/${source.captureId}/translation/`,
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'error',
        method: 'POST',
        headers: { 'X-Capture-Lease': source.leaseKey },
      })
    )
    expect(vi.mocked(fetchApi).mock.calls[0][1]?.body).not.toContain(
      source.leaseKey
    )
  })
  it('does not accept responses after an account/source change or retry a write', async () => {
    let current = true
    const api = captureTranslationApi(
      source,
      () => current,
      new AbortController().signal
    )
    vi.mocked(fetchApi).mockImplementationOnce(async () => {
      current = false
      return receipt()
    })
    await expect(api.control(intent())).rejects.toThrow(
      'translation_source_changed'
    )
    expect(fetchApi).toHaveBeenCalledTimes(1)
    await expect(api.read()).rejects.toThrow('translation_source_changed')
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })
})
