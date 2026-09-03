import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  ApiTaskGroup,
  ApiTaskList,
  ApiTaskListGroup,
  ApiTaskSavedView,
} from '../api/ApiTask'
import {
  DEFAULT_TASK_COLUMN_ORDER,
  DEFAULT_TASK_COLUMNS,
  type TaskWorkspaceState,
} from '../taskWorkspaceState'
import { TaskWorkspaceNavigation } from './TaskWorkspaceNavigation'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const state: TaskWorkspaceState = {
  scope: 'all',
  status: 'open',
  time: 'all',
  priority: 'all',
  ordering: '',
  grouping: 'none',
  columns: [...DEFAULT_TASK_COLUMNS],
  columnOrder: [...DEFAULT_TASK_COLUMN_ORDER],
  taskList: 'all',
  group: 'all',
  mode: 'list',
}

const listGroup: ApiTaskListGroup = {
  id: 'group-1',
  name: 'Team management',
  sort_order: 0,
  creator: null,
  can_manage: true,
  list_count: 1,
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
}

const savedView: ApiTaskSavedView = {
  id: 'saved-view-1',
  name: 'Urgent this week',
  config: {
    version: 1,
    scope: 'assigned',
    status: 'open',
    time: 'all',
    priority: 'urgent',
    task_list: 'all',
    ordering: 'due_date',
    view: 'list',
  },
  position: 0,
  is_pinned: true,
  is_default: false,
  invalid_task_list: false,
  invalid_task_group: false,
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
}

const taskGroup: ApiTaskGroup = {
  id: 'task-group-1',
  name: 'Development',
  sort_order: 0,
  task_count: 3,
  can_delete: false,
  can_manage: true,
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
}

const taskList = (
  id: string,
  name: string,
  group: ApiTaskList['list_group'],
  overrides: Partial<ApiTaskList> = {}
): ApiTaskList => ({
  id,
  name,
  description: '',
  color: 'blue',
  creator: null,
  list_group: group,
  is_archived: false,
  access_role: 'owner',
  can_manage: true,
  can_share: true,
  can_archive: true,
  can_remove: false,
  can_delete: true,
  can_create_tasks: true,
  task_count: 2,
  groups: [],
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
  ...overrides,
})

const renderNavigation = (navigationState = state, standaloneTaskCount = 0) => {
  const onTaskListChange = vi.fn()
  const onCreateTaskList = vi.fn()
  const onCreateTaskListGroup = vi.fn()
  const onMoveTaskList = vi.fn()
  const onRenameTaskListGroup = vi.fn()
  const onDeleteTaskListGroup = vi.fn()
  const onShareTaskList = vi.fn()
  const onRenameTaskList = vi.fn()
  const onArchiveTaskList = vi.fn()
  const onLeaveTaskList = vi.fn()
  const onDeleteTaskList = vi.fn()
  const onOpenArchivedTaskLists = vi.fn()
  const onOpenActivity = vi.fn()
  render(
    <TaskWorkspaceNavigation
      state={navigationState}
      count={4}
      taskLists={[
        taskList('list-1', 'Hiring', {
          id: listGroup.id,
          name: listGroup.name,
          sort_order: listGroup.sort_order,
        }),
        taskList('list-2', 'Requirements', null),
      ]}
      taskListGroups={[listGroup]}
      standaloneTaskCount={standaloneTaskCount}
      onChange={vi.fn()}
      onTaskListChange={onTaskListChange}
      onCreateTaskList={onCreateTaskList}
      onCreateTaskListGroup={onCreateTaskListGroup}
      onMoveTaskList={onMoveTaskList}
      onRenameTaskListGroup={onRenameTaskListGroup}
      onDeleteTaskListGroup={onDeleteTaskListGroup}
      onShareTaskList={onShareTaskList}
      onRenameTaskList={onRenameTaskList}
      onArchiveTaskList={onArchiveTaskList}
      onLeaveTaskList={onLeaveTaskList}
      onDeleteTaskList={onDeleteTaskList}
      onOpenArchivedTaskLists={onOpenArchivedTaskLists}
      onOpenActivity={onOpenActivity}
    />
  )
  return {
    onTaskListChange,
    onCreateTaskList,
    onCreateTaskListGroup,
    onMoveTaskList,
    onRenameTaskListGroup,
    onDeleteTaskListGroup,
    onShareTaskList,
    onRenameTaskList,
    onArchiveTaskList,
    onLeaveTaskList,
    onDeleteTaskList,
    onOpenArchivedTaskLists,
    onOpenActivity,
  }
}

describe('TaskWorkspaceNavigation', () => {
  it('does not expose completed as a predefined view', () => {
    renderNavigation()

    expect(
      screen.queryByRole('button', { name: 'workspace.views.completed' })
    ).not.toBeInTheDocument()
  })

  it('opens the cross-task activity feed from quick access', () => {
    const { onOpenActivity } = renderNavigation()

    fireEvent.click(screen.getByRole('button', { name: 'activity.navigation' }))

    expect(onOpenActivity).toHaveBeenCalledOnce()
  })

  it('selects and manages personal saved views', () => {
    const onSelectSavedView = vi.fn()
    const onCreateSavedView = vi.fn()
    const onUpdateSavedView = vi.fn()
    const onSetDefaultSavedView = vi.fn()
    render(
      <TaskWorkspaceNavigation
        state={{ ...state, savedView: savedView.id }}
        count={4}
        taskLists={[]}
        taskListGroups={[]}
        standaloneTaskCount={0}
        savedViews={[savedView]}
        savedViewChanged
        onChange={vi.fn()}
        onTaskListChange={vi.fn()}
        onCreateTaskList={vi.fn()}
        onCreateTaskListGroup={vi.fn()}
        onMoveTaskList={vi.fn()}
        onRenameTaskListGroup={vi.fn()}
        onDeleteTaskListGroup={vi.fn()}
        onSelectSavedView={onSelectSavedView}
        onCreateSavedView={onCreateSavedView}
        onUpdateSavedView={onUpdateSavedView}
        onSetDefaultSavedView={onSetDefaultSavedView}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: savedView.name }))
    expect(onSelectSavedView).toHaveBeenCalledWith(savedView)
    expect(screen.getAllByRole('button', { current: 'page' })).toHaveLength(1)
    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent(
      savedView.name
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'savedViews.saveCurrent' })
    )
    expect(onCreateSavedView).toHaveBeenCalledOnce()

    const openMenu = () =>
      fireEvent.click(screen.getByRole('button', { name: 'savedViews.more' }))
    openMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'savedViews.saveChanges' })
    )
    expect(onUpdateSavedView).toHaveBeenCalledWith(savedView)

    openMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'savedViews.setDefault' })
    )
    expect(onSetDefaultSavedView).toHaveBeenCalledWith(savedView)
  })

  it('keeps unpinned saved views out of the sidebar and opens management', () => {
    const onManageSavedViews = vi.fn()
    render(
      <TaskWorkspaceNavigation
        state={state}
        count={0}
        taskLists={[]}
        taskListGroups={[]}
        standaloneTaskCount={0}
        savedViews={[{ ...savedView, is_pinned: false }]}
        onChange={vi.fn()}
        onTaskListChange={vi.fn()}
        onCreateTaskList={vi.fn()}
        onCreateTaskListGroup={vi.fn()}
        onMoveTaskList={vi.fn()}
        onRenameTaskListGroup={vi.fn()}
        onDeleteTaskListGroup={vi.fn()}
        onManageSavedViews={onManageSavedViews}
      />
    )

    expect(
      screen.queryByRole('button', { name: savedView.name })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'savedViews.manage' }))
    expect(onManageSavedViews).toHaveBeenCalledOnce()
  })

  it('falls back to the matching system entry for a stale saved view id', () => {
    renderNavigation({ ...state, savedView: 'deleted-view' })

    expect(screen.getAllByRole('button', { current: 'page' })).toHaveLength(1)
    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent(
      'workspace.views.all'
    )
  })

  it('selects and manages organization custom groups', () => {
    const onSelectTaskGroup = vi.fn()
    const onCreateTaskGroup = vi.fn()
    const onManageTaskGroups = vi.fn()
    render(
      <TaskWorkspaceNavigation
        state={{ ...state, group: taskGroup.id }}
        count={3}
        taskLists={[]}
        taskListGroups={[]}
        taskGroups={[taskGroup]}
        standaloneTaskCount={0}
        onChange={vi.fn()}
        onTaskListChange={vi.fn()}
        onCreateTaskList={vi.fn()}
        onCreateTaskListGroup={vi.fn()}
        onMoveTaskList={vi.fn()}
        onRenameTaskListGroup={vi.fn()}
        onDeleteTaskListGroup={vi.fn()}
        onSelectTaskGroup={onSelectTaskGroup}
        onCreateTaskGroup={onCreateTaskGroup}
        onManageTaskGroups={onManageTaskGroups}
      />
    )

    const groupButton = screen.getByRole('button', { name: /Development/ })
    expect(groupButton).toHaveAttribute('aria-current', 'page')
    fireEvent.click(groupButton)
    expect(onSelectTaskGroup).toHaveBeenCalledWith(taskGroup)
    fireEvent.click(screen.getByRole('button', { name: 'groups.create' }))
    expect(onCreateTaskGroup).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'groups.manage' }))
    expect(onManageTaskGroups).toHaveBeenCalledOnce()
  })

  it('groups task lists, supports collapsing, dragging, and group actions', () => {
    const {
      onCreateTaskList,
      onMoveTaskList,
      onRenameTaskListGroup,
      onDeleteTaskListGroup,
    } = renderNavigation()

    expect(screen.getAllByText('Requirements')).not.toHaveLength(0)
    expect(screen.getByText('Team management')).toBeInTheDocument()
    expect(screen.getByText('Hiring')).toBeInTheDocument()

    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByRole('button', { name: /Requirements/ }), {
      dataTransfer,
    })
    fireEvent.drop(screen.getByText('Team management').closest('section')!, {
      dataTransfer,
    })
    expect(onMoveTaskList).toHaveBeenCalledWith('list-2', listGroup.id)

    fireEvent.click(
      screen.getByRole('button', { name: 'taskListGroups.createListIn' })
    )
    expect(onCreateTaskList).toHaveBeenCalledWith(listGroup.id)

    const collapseButton = screen.getByRole('button', {
      name: 'taskListGroups.collapse',
    })
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(collapseButton)
    expect(screen.queryByText('Hiring')).not.toBeInTheDocument()

    const groupMenuButton = screen.getByRole('button', {
      name: 'taskListGroups.more',
    })
    expect(groupMenuButton).toHaveAttribute('aria-haspopup', 'true')
    const openGroupMenu = () => fireEvent.click(groupMenuButton)

    openGroupMenu()
    expect(groupMenuButton).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'taskLists.create' }))
    expect(onCreateTaskList).toHaveBeenCalledWith(listGroup.id)

    openGroupMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'taskListGroups.rename' })
    )
    expect(onRenameTaskListGroup).toHaveBeenCalledWith(listGroup)

    openGroupMenu()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'taskListGroups.delete' })
    )
    expect(onDeleteTaskListGroup).toHaveBeenCalledWith(listGroup)
  })

  it('offers separate actions for creating a task list and a list group', async () => {
    const { onCreateTaskList, onCreateTaskListGroup, onOpenArchivedTaskLists } =
      renderNavigation()

    fireEvent.click(screen.getByRole('button', { name: 'taskLists.title' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'taskListGroups.create' })
    )
    expect(onCreateTaskListGroup).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'taskLists.title' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'taskLists.create' })
    )
    expect(onCreateTaskList).toHaveBeenCalledWith()

    fireEvent.click(screen.getByRole('button', { name: 'taskLists.title' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'taskLists.archivedTitle' })
    )
    expect(onOpenArchivedTaskLists).toHaveBeenCalledOnce()
  })

  it('offers collaboration and lifecycle actions on each task list', () => {
    const {
      onShareTaskList,
      onRenameTaskList,
      onArchiveTaskList,
      onLeaveTaskList,
      onDeleteTaskList,
    } = renderNavigation()
    const openListMenu = () =>
      fireEvent.click(
        screen.getAllByRole('button', { name: 'taskLists.more' })[0]
      )

    for (const [action, callback] of [
      ['taskLists.share', onShareTaskList],
      ['taskLists.rename', onRenameTaskList],
      ['taskLists.archive', onArchiveTaskList],
      ['taskLists.delete', onDeleteTaskList],
    ] as const) {
      openListMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: action }))
      expect(callback).toHaveBeenCalledOnce()
    }

    openListMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'taskLists.leave' }))
    expect(onLeaveTaskList).not.toHaveBeenCalled()
  })

  it('does not expose delete to a non-owner', () => {
    render(
      <TaskWorkspaceNavigation
        state={state}
        count={1}
        taskLists={[
          taskList('viewer-list', 'Read only', null, {
            access_role: 'viewer',
            can_manage: false,
            can_share: false,
            can_archive: false,
            can_delete: false,
            can_create_tasks: false,
          }),
        ]}
        taskListGroups={[]}
        standaloneTaskCount={0}
        onChange={vi.fn()}
        onTaskListChange={vi.fn()}
        onCreateTaskList={vi.fn()}
        onCreateTaskListGroup={vi.fn()}
        onMoveTaskList={vi.fn()}
        onRenameTaskListGroup={vi.fn()}
        onDeleteTaskListGroup={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'taskLists.more' }))
    expect(
      screen.queryByRole('menuitem', { name: 'taskLists.delete' })
    ).not.toBeInTheDocument()
  })

  it('offers leave when membership removal is allowed', () => {
    const onLeaveTaskList = vi.fn()
    render(
      <TaskWorkspaceNavigation
        state={state}
        count={1}
        taskLists={[
          taskList('leave-list', 'Leave me', null, {
            access_role: 'editor',
            can_manage: false,
            can_share: false,
            can_archive: false,
            can_delete: false,
            can_create_tasks: false,
            can_remove: true,
          }),
        ]}
        taskListGroups={[]}
        standaloneTaskCount={0}
        onChange={vi.fn()}
        onTaskListChange={vi.fn()}
        onCreateTaskList={vi.fn()}
        onCreateTaskListGroup={vi.fn()}
        onMoveTaskList={vi.fn()}
        onRenameTaskListGroup={vi.fn()}
        onDeleteTaskListGroup={vi.fn()}
        onLeaveTaskList={onLeaveTaskList}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'taskLists.more' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'taskLists.leave' }))
    expect(onLeaveTaskList).toHaveBeenCalledOnce()
  })

  it('marks only the selected task list as the current page', () => {
    renderNavigation({ ...state, taskList: 'list-1' })

    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent(
      'Hiring'
    )
  })

  it('shows standalone tasks at the bottom without a task-list action menu', () => {
    const { onTaskListChange } = renderNavigation(state, 2)

    const standalone = screen.getByRole('button', {
      name: 'taskLists.standalone',
    })
    fireEvent.click(standalone)

    expect(onTaskListChange).toHaveBeenCalledWith('unassigned')
    expect(
      screen.getAllByRole('button', { name: 'taskLists.more' })
    ).toHaveLength(2)
  })

  it('hides the standalone task list when there are no standalone tasks', () => {
    renderNavigation()

    expect(
      screen.queryByRole('button', { name: 'taskLists.standalone' })
    ).not.toBeInTheDocument()
  })
})

const createDataTransfer = () => {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) || '',
  }
}
