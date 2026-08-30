import { describe, expect, it } from 'vitest'

import type { ApiTask } from './api/ApiTask'
import {
  incompleteDescendantCount,
  nextTaskStatuses,
  quickTaskStatus,
  taskAssignees,
} from './taskUi'

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

  it('falls back to the single assignee when the list is absent', () => {
    const assignee = {
      id: 'u1',
      full_name: 'Alice',
      short_name: null,
      avatar_url: '',
    }
    expect(taskAssignees({ assignee })).toEqual([assignee])
    expect(taskAssignees({ assignees: [], assignee })).toEqual([])
  })

  it('clamps incomplete descendant counts at zero', () => {
    expect(
      incompleteDescendantCount({
        descendant_progress: { total: 5, completed: 2 },
      })
    ).toBe(3)
    expect(
      incompleteDescendantCount({
        descendant_progress: { total: 2, completed: 3 },
      })
    ).toBe(0)
  })
})
