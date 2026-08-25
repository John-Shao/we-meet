import { describe, expect, it } from 'vitest'

import type { ApiTask } from './api/ApiTask'
import { nextTaskStatuses, quickTaskStatus } from './taskUi'

const permissions = (status: ApiTask['status'], canUpdateStatus = true) => ({
  status,
  can_update_status: canUpdateStatus,
})

describe('task workbench status actions', () => {
  it('only transitions between incomplete and completed', () => {
    expect(nextTaskStatuses(permissions('todo'))).toEqual(['completed'])
    expect(nextTaskStatuses(permissions('completed'))).toEqual(['todo'])
  })

  it('only exposes a quick status action when the API grants permission', () => {
    expect(quickTaskStatus(permissions('todo'))).toBe('completed')
    expect(quickTaskStatus(permissions('completed'))).toBe('todo')
    expect(quickTaskStatus(permissions('todo', false))).toBeUndefined()
  })
})
