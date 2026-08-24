import { describe, expect, it } from 'vitest'

import type { ApiTask } from './api/ApiTask'
import { nextTaskStatuses, quickTaskStatus } from './taskUi'

const permissions = (
  status: ApiTask['status'],
  canCancel: boolean,
  canUpdateStatus = true
) => ({ status, can_cancel: canCancel, can_update_status: canUpdateStatus })

describe('task workbench status actions', () => {
  it('keeps cancellation exclusive to the creator', () => {
    expect(nextTaskStatuses(permissions('todo', false))).toEqual([
      'in_progress',
      'completed',
    ])
    expect(nextTaskStatuses(permissions('todo', true))).toContain('canceled')
    expect(nextTaskStatuses(permissions('canceled', false))).toEqual([])
    expect(nextTaskStatuses(permissions('canceled', true))).toEqual(['todo'])
  })

  it('only exposes a quick status action when the API grants permission', () => {
    expect(quickTaskStatus(permissions('todo', false))).toBe('completed')
    expect(quickTaskStatus(permissions('completed', false))).toBe('todo')
    expect(quickTaskStatus(permissions('todo', false, false))).toBeUndefined()
    expect(quickTaskStatus(permissions('canceled', false))).toBeUndefined()
  })
})
