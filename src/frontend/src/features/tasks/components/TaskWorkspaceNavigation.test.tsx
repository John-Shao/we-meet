import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskList, ApiTaskListGroup } from '../api/ApiTask'
import type { TaskWorkspaceState } from '../taskWorkspaceState'
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
  taskList: 'all',
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
  can_remove: true,
  can_delete: true,
  can_create_tasks: true,
  task_count: 2,
  groups: [],
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
  ...overrides,
})

const renderNavigation = () => {
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
  render(
    <TaskWorkspaceNavigation
      state={state}
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
      onChange={vi.fn()}
      onTaskListChange={vi.fn()}
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
    />
  )
  return {
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
  }
}

describe('TaskWorkspaceNavigation', () => {
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

    fireEvent.click(
      screen.getByRole('button', { name: 'taskListGroups.collapse' })
    )
    expect(screen.queryByText('Hiring')).not.toBeInTheDocument()

    const openGroupMenu = () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'taskListGroups.more' })
      )

    openGroupMenu()
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
      ['taskLists.leave', onLeaveTaskList],
      ['taskLists.delete', onDeleteTaskList],
    ] as const) {
      openListMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: action }))
      expect(callback).toHaveBeenCalledOnce()
    }
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
