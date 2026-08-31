import { describe, expect, it } from 'vitest'

import {
  buildTaskWorkspaceSearch,
  DEFAULT_TASK_COLUMNS,
  effectiveTaskColumns,
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
      status: 'open',
      time: 'overdue',
      priority: 'high',
      ordering: '-due_date',
      grouping: 'none',
      columns: [
        'title',
        'assignee',
        'priority',
        'startDate',
        'dueDate',
        'taskList',
        'creator',
        'createdAt',
      ],
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
    ).toBe('none')
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
      scope: 'assigned',
      status: 'open',
      taskList: 'list-1',
      mode: 'list',
    })
    expect(stateForTaskList(state, 'unassigned')).toMatchObject({
      scope: 'assigned',
      status: 'open',
      priority: 'urgent',
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
        grouping: 'none',
        columns: [...DEFAULT_TASK_COLUMNS],
        taskList: 'list/id',
        mode: 'board',
        task: 'task-id',
        savedView: 'view-id',
      })
    ).toBe(
      'scope=all&status=completed&time=all&priority=low&ordering=-created_at&grouping=none&columns=title%2Cassignee%2Cpriority%2CstartDate%2CdueDate%2CtaskList%2Ccreator%2CcreatedAt&task_list=list%2Fid&view=board&task=task-id&saved_view=view-id'
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
      version: 2,
      scope: 'following',
      status: 'all',
      time: 'overdue',
      priority: 'urgent',
      task_list: 'list-1',
      ordering: 'due_date',
      view: 'board',
      grouping: 'none',
      columns: [
        'title',
        'assignee',
        'priority',
        'startDate',
        'dueDate',
        'taskList',
        'creator',
        'createdAt',
      ],
    })
    expect(stateForSavedView(state, config)).toEqual({
      ...state,
      task: undefined,
    })
  })

  it('applies only the fields fixed by the current view', () => {
    const base = parseTaskWorkspaceState(new URLSearchParams())

    expect(
      effectiveTaskColumns({
        ...base,
        scope: 'created',
        status: 'all',
        columns: ['title', 'creator', 'completedAt'],
      })
    ).toEqual(['title', 'completedAt'])
    expect(
      effectiveTaskColumns({
        ...base,
        status: 'completed',
        taskList: 'list-1',
        columns: ['title', 'taskList'],
      })
    ).toEqual(['title', 'completedAt'])
  })
})
