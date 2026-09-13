import { describe, expect, it } from 'vitest'
import {
  CapturePayload,
  CaptureRun,
  isCapturePayload,
  isCaptureReceipt,
  isCaptureState,
} from './ApiOnlineCapture'

const room = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const record = '33333333-3333-4333-8333-333333333333'
const sid = 'RM_current'
const start: CapturePayload = {
  room_id: room,
  livekit_room_sid: sid,
  operation: 'start',
  expected_run_id: null,
}
const run: CaptureRun = {
  id,
  record_id: record,
  state: 'starting',
  error_code: '',
  coverage: 'unverified',
  started_at: null,
  ended_at: null,
}

describe('online capture protocol', () => {
  it('validates exact occurrence and explicit nullable expected run', () => {
    expect(isCapturePayload(start, room, sid)).toBe(true)
    for (const bad of [
      { ...start, expected_run_id: undefined },
      { ...start, operation: 'stop' },
      { ...start, room_id: id },
      { ...start, livekit_room_sid: 'RM_old' },
      { ...start, extra: true },
    ]) {
      expect(isCapturePayload(bad, room, sid)).toBe(false)
    }
  })
  it('does not accept incomplete state as permission or valid recording coverage', () => {
    expect(
      isCaptureState({ available: false, can_control: true, current: run })
    ).toBe(true)
    for (const bad of [
      { current: null },
      { available: true, can_control: true },
      {
        available: true,
        can_control: true,
        current: { ...run, coverage: 'complete' },
      },
    ]) {
      expect(isCaptureState(bad)).toBe(false)
    }
  })
  it('matches the frozen start receipt while allowing a newer current run', () => {
    expect(
      isCaptureReceipt(
        {
          result: run,
          current: { ...run, id: room, state: 'recording' },
          replayed: true,
        },
        start
      )
    ).toBe(true)
    for (const bad of [
      { current: run },
      { result: run, current: run },
      { result: { ...run, state: 'recording' }, current: run, replayed: false },
      { result: run, current: { ...run, record_id: room }, replayed: true },
    ]) {
      expect(isCaptureReceipt(bad, start)).toBe(false)
    }
    expect(
      isCaptureReceipt(
        { result: run, current: run, replayed: true },
        { ...start, expected_run_id: id }
      )
    ).toBe(false)
  })
  it('only resolves stop for the exact previously observed run', () => {
    const stop: CapturePayload = {
      ...start,
      operation: 'stop',
      expected_run_id: id,
    }
    expect(
      isCaptureReceipt(
        {
          result: { ...run, state: 'stopping' },
          current: null,
          replayed: true,
        },
        stop
      )
    ).toBe(true)
    expect(
      isCaptureReceipt(
        {
          result: { ...run, id: room, state: 'stopped' },
          current: null,
          replayed: true,
        },
        stop
      )
    ).toBe(false)
  })
  it('rejects malformed identities, unknown states and reversed timestamps', () => {
    for (const bad of [
      { ...run, id: 'invalid' },
      { ...run, state: 'future' },
      { ...run, started_at: 'yesterday' },
      {
        ...run,
        started_at: '2026-09-13T02:00:00Z',
        ended_at: '2026-09-13T01:00:00Z',
      },
    ]) {
      expect(
        isCaptureState({ available: true, can_control: true, current: bad })
      ).toBe(false)
    }
  })
})
