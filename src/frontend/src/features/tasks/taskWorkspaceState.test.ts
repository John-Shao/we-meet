import { describe, expect, it } from 'vitest'

import {
  buildTaskWorkspaceSearch,
  parseTaskWorkspaceState,
  stateForTaskList,
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
      taskList: 'all',
      mode: 'list',
    })
    expect(
      parseTaskWorkspaceState(
        new URLSearchParams(
          'scope=created&status=todo&time=overdue&priority=high&label=abc&task_list=list-1&view=board&task=42'
        )
      )
    ).toEqual({
      scope: 'created',
      status: 'todo',
      time: 'overdue',
      priority: 'high',
      label: 'abc',
      taskList: 'list-1',
      mode: 'board',
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
    expect(stateForTaskList(state, 'list-1')).toMatchObject({
      scope: 'all',
      status: 'open',
      taskList: 'list-1',
      mode: 'list',
    })
  })

  it('serializes deep links with every workbench filter', () => {
    expect(
      buildTaskWorkspaceSearch({
        scope: 'all',
        status: 'completed',
        time: 'all',
        priority: 'low',
        label: 'label/id',
        taskList: 'list/id',
        mode: 'board',
        task: 'task-id',
      })
    ).toBe(
      'scope=all&status=completed&time=all&priority=low&label=label%2Fid&task_list=list%2Fid&view=board&task=task-id'
    )
  })
})
