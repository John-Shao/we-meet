import { describe, expect, it } from 'vitest'

import {
  buildTaskWorkspaceSearch,
  parseTaskWorkspaceState,
  stateForTaskList,
  stateForSavedView,
  stateForView,
  stateWithStatus,
  taskViewPresets,
  taskWorkspaceStateToSavedViewConfig,
} from './taskWorkspaceState'

describe('task workspace state', () => {
  it('maps the five quick views to scope and status', () => {
    expect(taskViewPresets).toEqual({
      assigned: { scope: 'assigned', status: 'open' },
      created: { scope: 'created', status: 'open' },
      following: { scope: 'following', status: 'open' },
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
      ordering: '',
      taskList: 'all',
      mode: 'list',
    })
    expect(
      parseTaskWorkspaceState(
        new URLSearchParams(
          'scope=created&status=todo&time=overdue&priority=high&ordering=-due_date&task_list=list-1&view=board&task=42&saved_view=view-1'
        )
      )
    ).toEqual({
      scope: 'created',
      status: 'todo',
      time: 'overdue',
      priority: 'high',
      ordering: '-due_date',
      taskList: 'list-1',
      mode: 'board',
      task: '42',
      savedView: 'view-1',
    })
  })

  it('ignores unsupported ordering fields', () => {
    expect(
      parseTaskWorkspaceState(new URLSearchParams('ordering=-updated_at'))
        .ordering
    ).toBe('')
    expect(
      parseTaskWorkspaceState(new URLSearchParams('ordering=status')).ordering
    ).toBe('')
    expect(
      parseTaskWorkspaceState(new URLSearchParams('priority=none')).priority
    ).toBe('all')
  })

  it('preserves priority while resetting time for closed views', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('time=due_today&priority=urgent')
    )
    expect(stateForView(state, 'completed')).toMatchObject({
      scope: 'all',
      status: 'completed',
      time: 'all',
      priority: 'urgent',
    })
    expect(stateWithStatus(state, 'completed').time).toBe('all')
    expect(stateForTaskList(state, 'list-1')).toMatchObject({
      scope: 'all',
      status: 'open',
      taskList: 'list-1',
      mode: 'list',
    })
    expect(stateForTaskList(state, 'unassigned')).toMatchObject({
      scope: 'all',
      status: 'all',
      priority: 'all',
      taskList: 'unassigned',
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
        ordering: '-created_at',
        taskList: 'list/id',
        mode: 'board',
        task: 'task-id',
        savedView: 'view-id',
      })
    ).toBe(
      'scope=all&status=completed&time=all&priority=low&ordering=-created_at&task_list=list%2Fid&view=board&task=task-id&saved_view=view-id'
    )
  })

  it('round-trips the shared_via token through navigation state', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('shared_via=conv-123&task=task-1')
    )
    expect(state.sharedVia).toBe('conv-123')
    expect(buildTaskWorkspaceSearch(state)).toContain('shared_via=conv-123')
  })

  it('round-trips the supported saved view configuration without task detail state', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams(
        'scope=following&status=all&time=overdue&priority=urgent&ordering=due_date&task_list=list-1&view=board&task=task-1'
      )
    )
    const config = taskWorkspaceStateToSavedViewConfig(state)

    expect(config).toEqual({
      version: 1,
      scope: 'following',
      status: 'all',
      time: 'overdue',
      priority: 'urgent',
      task_list: 'list-1',
      ordering: 'due_date',
      view: 'board',
    })
    expect(stateForSavedView(state, config)).toEqual({
      ...state,
      task: undefined,
    })
  })
})
