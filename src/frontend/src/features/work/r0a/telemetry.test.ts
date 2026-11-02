import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  sanitizeWorkEvent,
  setWorkTelemetrySink,
  trackWorkEvent,
  WORK_EVENTS,
  type WorkEventProps,
} from './telemetry'

// D5 §10:305 names these nine and only these nine. Adding a tenth event is a design
// edit, not a code edit, so the list is asserted as an exact set.
const D5_EVENT_NAMES = [
  'work_r0a_home_view',
  'composer_preview',
  'task_submit',
  'task_accept',
  'artifact_save',
  'task_retry',
  'task_cancel',
  'sse_resync',
  'inbox_open',
]

afterEach(() => {
  setWorkTelemetrySink(null)
})

describe('sanitizeWorkEvent', () => {
  it('carries identifiers, state, duration and error code', () => {
    expect(
      sanitizeWorkEvent({
        orgId: 'org_1',
        subjectId: 'sub_1',
        taskId: 'task_1',
        runId: 'run_1',
        artifactId: 'artifact_1',
        state: 'succeeded',
        displayState: 'awaiting_acceptance',
        errorCode: 'version_conflict',
        durationMs: 1234.6,
      })
    ).toEqual({
      org_id: 'org_1',
      subject_id: 'sub_1',
      task_id: 'task_1',
      run_id: 'run_1',
      artifact_id: 'artifact_1',
      state: 'succeeded',
      display_state: 'awaiting_acceptance',
      error_code: 'version_conflict',
      duration_ms: 1235,
    })
  })

  it('drops keys outside the allow list, including prose fields', () => {
    const smuggled = {
      taskId: 'task_1',
      title: 'the whole task title',
      goal: 'the whole task background',
      content: '# artifact body',
      email: 'someone@example.com',
    } as unknown as WorkEventProps

    const payload = sanitizeWorkEvent(smuggled)

    expect(Object.keys(payload)).toEqual(['task_id'])
    expect(JSON.stringify(payload)).not.toContain('the whole task title')
    expect(JSON.stringify(payload)).not.toContain('someone@example.com')
  })

  it('drops values that are not shaped like identifiers or enums', () => {
    expect(
      sanitizeWorkEvent({
        state: 'x'.repeat(121),
        errorCode: '',
        durationMs: Number.NaN,
      })
    ).toEqual({})
  })
})

describe('trackWorkEvent', () => {
  it('is a no-op while no destination is configured', () => {
    expect(() =>
      trackWorkEvent('inbox_open', { taskId: 'task_1' })
    ).not.toThrow()
    expect(trackWorkEvent('task_submit', { taskId: 'task_1' })).toBe(false)
  })

  it('hands the sink an allow-listed payload only', () => {
    const sink = vi.fn()
    setWorkTelemetrySink(sink)

    expect(
      trackWorkEvent('task_cancel', {
        taskId: 'task_1',
        durationMs: 20,
      })
    ).toBe(true)

    expect(sink).toHaveBeenCalledWith('task_cancel', {
      task_id: 'task_1',
      duration_ms: 20,
    })
  })

  it('stops emitting once the sink is removed again', () => {
    const sink = vi.fn()
    setWorkTelemetrySink(sink)
    trackWorkEvent('task_accept', { taskId: 'task_1' })
    setWorkTelemetrySink(null)

    expect(trackWorkEvent('task_accept', { taskId: 'task_1' })).toBe(false)
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

describe('WORK_EVENTS', () => {
  it('is exactly the nine events D5 §10 lists', () => {
    expect([...WORK_EVENTS].sort()).toEqual([...D5_EVENT_NAMES].sort())
    expect(WORK_EVENTS.length).toBe(9)
  })
})
