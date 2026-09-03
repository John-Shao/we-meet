import { describe, expect, it } from 'vitest'

import type { TaskColumnId } from './api/ApiTask'

import {
  buildTaskWorkspaceSearch,
  DEFAULT_TASK_COLUMN_ORDER,
  DEFAULT_TASK_COLUMNS,
  effectiveTaskColumns,
  parseTaskWorkspaceState,
  stateForTaskList,
  stateForTaskGroup,
  stateForView,
  stateWithTaskWorkspacePreferences,
  stateWithStatus,
  taskColumnViewKey,
  taskPreferencesViewKey,
  taskViewPresets,
  taskWorkspacePreferences,
} from './taskWorkspaceState'

describe('task workspace state', () => {
  it('maps the four quick views to scope and status', () => {
    expect(taskViewPresets).toEqual({
      assigned: { scope: 'assigned', status: 'open' },
      created: { scope: 'created', status: 'open' },
      following: { scope: 'following', status: 'open' },
      all: { scope: 'all', status: 'open' },
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
      group: 'all',
      mode: 'list',
    })
    expect(
      parseTaskWorkspaceState(
        new URLSearchParams(
          'scope=created&status=todo&time=overdue&priority=high&ordering=-due_date&task_list=list-1&group=group-1&view=board&task=42'
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
        'createdAt',
      ],
      columnOrder: [...DEFAULT_TASK_COLUMN_ORDER],
      taskList: 'list-1',
      group: 'group-1',
      mode: 'board',
      task: '42',
      sharedVia: undefined,
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

  it('uses isolated defaults when opening a task-list view', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('time=due_today&priority=urgent')
    )
    expect(stateWithStatus(state, 'completed').time).toBe('all')
    expect(stateForTaskList(state, 'list-1')).toMatchObject({
      scope: 'all',
      status: 'open',
      time: 'all',
      priority: 'all',
      taskList: 'list-1',
      group: 'all',
      mode: 'list',
      columns: DEFAULT_TASK_COLUMNS.filter((column) => column !== 'taskList'),
    })
    expect(stateForTaskList(state, 'unassigned')).toMatchObject({
      scope: 'all',
      status: 'open',
      time: 'all',
      priority: 'all',
      taskList: 'unassigned',
      group: 'all',
      mode: 'list',
    })
  })

  it('uses view context only to choose initial field defaults', () => {
    expect(
      parseTaskWorkspaceState(
        new URLSearchParams('scope=created&status=completed&task_list=list-1')
      ).columns
    ).toEqual(
      DEFAULT_TASK_COLUMNS.filter(
        (column) => column !== 'creator' && column !== 'taskList'
      ).concat('completedAt')
    )
  })

  it('does not leak filters into a predefined view', () => {
    const assigned = parseTaskWorkspaceState(new URLSearchParams())
    const assignedPreferences = taskWorkspacePreferences(assigned)
    const filteredState = {
      ...assigned,
      scope: 'all' as const,
      time: 'starting_today' as const,
      priority: 'urgent' as const,
    }

    expect(
      stateWithTaskWorkspacePreferences(
        stateForView(filteredState, 'assigned'),
        assignedPreferences
      )
    ).toMatchObject({
      scope: 'assigned',
      status: 'open',
      time: 'all',
      priority: 'all',
      ordering: '',
      grouping: 'none',
      mode: 'list',
      taskList: 'all',
      group: 'all',
    })
  })

  it('opens a custom group as an isolated global task view', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('task_list=list-1&grouping=custom')
    )

    expect(stateForTaskGroup(state, 'group-1')).toMatchObject({
      scope: 'all',
      status: 'open',
      time: 'all',
      priority: 'all',
      taskList: 'all',
      group: 'group-1',
      grouping: 'none',
      mode: 'list',
    })
  })

  it('keeps column defaults isolated between quick and task-list views', () => {
    const state = {
      ...parseTaskWorkspaceState(new URLSearchParams()),
      columns: ['title', 'completedAt'] as TaskColumnId[],
    }

    expect(stateForView(state, 'assigned').columns).toEqual(
      DEFAULT_TASK_COLUMNS
    )
    expect(stateForView(state, 'created').columns).toEqual(
      DEFAULT_TASK_COLUMNS.filter((column) => column !== 'creator')
    )
    expect(stateForTaskList(state, 'list-1').columns).toEqual(
      DEFAULT_TASK_COLUMNS.filter((column) => column !== 'taskList')
    )
  })

  it('isolates quick views while sharing one task-list profile', () => {
    const state = parseTaskWorkspaceState(new URLSearchParams())
    expect(taskColumnViewKey(state)).toBe('quick:assigned')
    expect(taskColumnViewKey({ ...state, scope: 'created' })).toBe(
      'quick:created'
    )
    expect(taskColumnViewKey({ ...state, taskList: 'list-1' })).toBe(
      'task-list'
    )
    expect(taskColumnViewKey({ ...state, taskList: 'list-2' })).toBe(
      'task-list'
    )
    expect(taskColumnViewKey({ ...state, taskList: 'unassigned' })).toBe(
      'standalone'
    )
  })

  it('isolates filter preferences for every predefined and task-list view', () => {
    const state = parseTaskWorkspaceState(new URLSearchParams())

    expect(taskPreferencesViewKey(state)).toBe('quick:assigned')
    expect(taskPreferencesViewKey({ ...state, scope: 'created' })).toBe(
      'quick:created'
    )
    expect(taskPreferencesViewKey({ ...state, taskList: 'list-1' })).toBe(
      'task-list:list-1'
    )
    expect(taskPreferencesViewKey({ ...state, taskList: 'list-2' })).toBe(
      'task-list:list-2'
    )
    expect(taskPreferencesViewKey({ ...state, taskList: 'unassigned' })).toBe(
      'standalone'
    )
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
        columnOrder: [...DEFAULT_TASK_COLUMN_ORDER],
        taskList: 'list/id',
        group: 'group/id',
        mode: 'board',
        task: 'task-id',
      })
    ).toBe(
      'scope=all&status=completed&time=all&priority=low&ordering=-created_at&grouping=none&columns=title%2Cassignee%2Cpriority%2CstartDate%2CdueDate%2CtaskList%2Ccreator%2CcreatedAt&column_order=title%2Cassignee%2Cpriority%2CstartDate%2CdueDate%2CtaskList%2CcustomGroup%2Ccreator%2CcreatedAt%2CcompletedAt&task_list=list%2Fid&group=group%2Fid&view=board&task=task-id'
    )
  })

  it('round-trips the shared_via token through navigation state', () => {
    const state = parseTaskWorkspaceState(
      new URLSearchParams('shared_via=conv-123&task=task-1')
    )
    expect(state.sharedVia).toBe('conv-123')
    expect(buildTaskWorkspaceSearch(state)).toContain('shared_via=conv-123')
  })

  it('only forces the task title and otherwise respects field visibility', () => {
    const base = parseTaskWorkspaceState(new URLSearchParams())

    expect(
      effectiveTaskColumns({
        ...base,
        scope: 'created',
        status: 'all',
        columns: ['title', 'creator', 'completedAt'],
      })
    ).toEqual(['title', 'creator', 'completedAt'])
    expect(
      effectiveTaskColumns({
        ...base,
        status: 'completed',
        taskList: 'list-1',
        columns: ['title', 'taskList'],
      })
    ).toEqual(['title', 'taskList'])
    expect(
      effectiveTaskColumns({
        ...base,
        columns: ['assignee'],
      })
    ).toEqual(['title', 'assignee'])
    expect(
      effectiveTaskColumns({
        ...base,
        columns: ['title', 'assignee', 'dueDate'],
        columnOrder: [
          'title',
          'dueDate',
          'assignee',
          ...DEFAULT_TASK_COLUMN_ORDER.filter(
            (column) => !['title', 'dueDate', 'assignee'].includes(column)
          ),
        ],
      })
    ).toEqual(['title', 'dueDate', 'assignee'])
  })
})
