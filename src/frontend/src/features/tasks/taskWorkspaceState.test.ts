import { describe, expect, it } from 'vitest'

import {
  buildTaskWorkspaceSearch,
  parseTaskWorkspaceState,
  stateForView,
  stateWithStatus,
  taskViewPresets,
} from './taskWorkspaceState'

describe('task workspace state', () => {
  it('maps the four quick views to scope and status', () => {
    expect(taskViewPresets).toEqual({
      assigned: { scope: 'assigned', status: 'open' },
      created: { scope: 'created', status: 'open' },
      all: { scope: 'all', status: 'open' },
      completed: { scope: 'all', status: 'completed' },
    })
  })

  it('uses the open assigned view by default and restores all filters', () => {
    expect(parseTaskWorkspaceState(new URLSearchParams())).toMatchObject({
      scope: 'assigned',
      status: 'open',
      time: 'all',
      priority: 'all',
      label: 'all',
    })
    expect(
      parseTaskWorkspaceState(
        new URLSearchParams(
          'scope=created&status=todo&time=overdue&priority=high&label=abc&task=42'
        )
      )
    ).toEqual({
      scope: 'created',
      status: 'todo',
      time: 'overdue',
      priority: 'high',
      label: 'abc',
      task: '42',
    })
  })

  it('preserves priority and label while resetting time for closed views', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('time=due_today&priority=urgent&label=abc')
    )
    expect(stateForView(state, 'completed')).toMatchObject({
      scope: 'all',
      status: 'completed',
      time: 'all',
      priority: 'urgent',
      label: 'abc',
    })
    expect(stateWithStatus(state, 'canceled').time).toBe('all')
  })

  it('serializes deep links with every workbench filter', () => {
    expect(
      buildTaskWorkspaceSearch({
        scope: 'all',
        status: 'completed',
        time: 'all',
        priority: 'low',
        label: 'label/id',
        task: 'task-id',
      })
    ).toBe(
      'scope=all&status=completed&time=all&priority=low&label=label%2Fid&task=task-id'
    )
  })
})
