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
  group: ApiTaskList['list_group']
): ApiTaskList => ({
  id,
  name,
  description: '',
  color: 'blue',
  creator: null,
  list_group: group,
  is_archived: false,
  can_manage: true,
  task_count: 2,
  groups: [],
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
})

const renderNavigation = () => {
  const onCreateTaskList = vi.fn()
  const onCreateTaskListGroup = vi.fn()
  const onMoveTaskList = vi.fn()
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
    />
  )
  return { onCreateTaskList, onCreateTaskListGroup, onMoveTaskList }
}

describe('TaskWorkspaceNavigation', () => {
  it('groups task lists, supports collapsing, and creates a list in a group', () => {
    const { onCreateTaskList, onMoveTaskList } = renderNavigation()

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
      screen.getByRole('button', { name: 'taskListGroups.collapse' })
    )
    expect(screen.queryByText('Hiring')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'taskListGroups.createListIn' })
    )
    expect(onCreateTaskList).toHaveBeenCalledWith(listGroup.id)
  })

  it('offers separate actions for creating a task list and a list group', async () => {
    const { onCreateTaskList, onCreateTaskListGroup } = renderNavigation()

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
