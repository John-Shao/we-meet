import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAutomationPayload,
  isSummaryPayload,
  useSummaryIntent,
} from './useSummaryIntent'

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())
const payload = { enabled: true, expected_revision: 0 }
const key = 'meeting-summary-intent:v1:["automation","viewer","record"]'
const show = () =>
  renderHook(() =>
    useSummaryIntent('automation', 'viewer', 'record', isAutomationPayload)
  )

describe('durable summary intents', () => {
  it('recovers across remount and preserves the original body against changed UI state', () => {
    const first = show()
    let intent: ReturnType<typeof first.result.current.getOrCreate>
    act(() => {
      intent = first.result.current.getOrCreate(payload)
    })
    first.unmount()
    const second = show()
    expect(second.result.current.pending).toEqual(intent!)
    act(() => {
      expect(
        second.result.current.getOrCreate({
          enabled: false,
          expected_revision: 9,
        })
      ).toEqual(intent!)
    })
    act(() => {
      expect(second.result.current.resolve(intent!)).toBe(true)
    })
    expect(sessionStorage.getItem(key)).toBeNull()
  })
  it('fails closed on corrupt and unavailable storage without replacing old data', () => {
    sessionStorage.setItem(key, '{invalid')
    const hook = show()
    expect(hook.result.current.ready).toBe(false)
    expect(hook.result.current.failed).toBe(true)
    act(() => {
      expect(() => hook.result.current.getOrCreate(payload)).toThrow()
    })
    expect(sessionStorage.getItem(key)).toBe('{invalid')
    sessionStorage.removeItem(key)
    act(() => hook.result.current.reload())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    act(() => {
      expect(() => hook.result.current.getOrCreate(payload)).toThrow()
    })
    expect(hook.result.current.ready).toBe(false)
  })
  it('does not clear a newer request when a late old response is resolved', () => {
    const hook = show()
    let first: ReturnType<typeof hook.result.current.getOrCreate>
    act(() => {
      first = hook.result.current.getOrCreate(payload)
    })
    act(() => {
      hook.result.current.resolve(first!)
    })
    let second: typeof first
    act(() => {
      second = hook.result.current.getOrCreate({
        enabled: false,
        expected_revision: 1,
      })
    })
    act(() => {
      expect(hook.result.current.resolve(first!)).toBe(false)
    })
    expect(hook.result.current.pending).toEqual(second!)
  })
  it('keeps accounts, records and operation kinds separate', () => {
    const hook = renderHook(
      ({ viewer, record }) =>
        useSummaryIntent('automation', viewer, record, isAutomationPayload),
      {
        initialProps: { viewer: 'viewer', record: 'record' },
      }
    )
    act(() => {
      hook.result.current.getOrCreate(payload)
    })
    hook.rerender({ viewer: 'other', record: 'record' })
    expect(hook.result.current.pending).toBeUndefined()
    hook.rerender({ viewer: 'viewer', record: 'other' })
    expect(hook.result.current.pending).toBeUndefined()
    const summary = renderHook(() =>
      useSummaryIntent('summary', 'viewer', 'record', isSummaryPayload)
    )
    expect(summary.result.current.pending).toBeUndefined()
    hook.rerender({ viewer: 'viewer', record: 'record' })
    expect(hook.result.current.pending?.payload).toEqual(payload)
  })
  it('validates required coordinates and does not accept extra private content', () => {
    const valid = {
      operation: 'generate',
      expected_revision: 1,
      expected_job_id: null,
      expected_attempt: null,
    }
    expect(isSummaryPayload(valid)).toBe(true)
    expect(isSummaryPayload({ ...valid, expected_attempt: 1 })).toBe(false)
    expect(
      isSummaryPayload({ ...valid, transcript: 'must not be persisted' })
    ).toBe(false)
    expect(isSummaryPayload({ ...valid, stage: 'unknown' })).toBe(false)
    expect(isAutomationPayload({ enabled: true, expected_revision: -1 })).toBe(
      false
    )
  })
})
