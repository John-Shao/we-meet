import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { TaskList } from './TaskList'

const mutate = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('../api/fetchTasks', () => ({
  usePatchTask: () => ({ mutate, isPending: false }),
}))

beforeAll(() => {
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as typeof PointerEvent
  }
})

const task: ApiTask = {
  id: 'task-1',
  title: 'Prepare release',
  description: 'Run the release checks',
  creator: {
    id: 'creator',
    full_name: 'Creator',
    short_name: null,
    avatar_url: '/creator.png',
  },
  assignee: {
    id: 'assignee',
    full_name: 'Assignee',
    short_name: null,
    avatar_url: '/assignee.png',
  },
  status: 'todo',
  priority: 'high',
  task_list: {
    id: 'list-1',
    name: 'Release work',
    color: 'blue',
  },
  group: null,
  position: 0,
  start_date: '2026-08-21',
  due_date: '2026-08-22',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: 'meeting-1',
  source_room_name: 'Weekly sync',
  can_edit: false,
  can_update_status: true,
  can_cancel: false,
  can_comment: true,
  can_manage_attachments: true,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

describe('TaskList', () => {
  it('renders desktop and mobile task representations with semantic metadata', () => {
    const { container } = render(
      <TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual([
      'workspace.columns.title',
      'workspace.columns.assignee',
      'workspace.columns.priority',
      'workspace.columns.startDate',
      'workspace.columns.dueDate',
      'workspace.columns.status',
      'workspace.columns.taskList',
      'workspace.columns.creator',
      'workspace.columns.createdAt',
    ])
    expect(within(table).getAllByText('statuses.todo')).toHaveLength(1)
    expect(
      screen.queryByLabelText('workspace.quickComplete')
    ).not.toBeInTheDocument()
    expect(screen.getAllByText('Prepare release')).toHaveLength(2)
    expect(screen.getAllByText('priorities.high')).toHaveLength(2)
    const formatDateTime = (value: string) =>
      new Intl.DateTimeFormat('en', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    expect(
      within(table).getAllByText(formatDateTime(task.created_at))
    ).toHaveLength(1)
    expect(
      within(table).queryByText(formatDateTime(task.updated_at))
    ).not.toBeInTheDocument()
    expect(container.querySelector('img[src="/assignee.png"]')).toBeTruthy()
    expect(container.querySelector('img[src="/creator.png"]')).toBeTruthy()
    expect(within(table).getByText('Release work')).toBeInTheDocument()
  })

  it('labels tasks without a task list as standalone', () => {
    render(
      <TaskList
        tasks={[{ ...task, task_list: null }]}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )

    expect(
      within(screen.getByRole('table')).getByText('taskLists.standalone')
    ).toBeInTheDocument()
  })

  it('opens a focused row with Enter', () => {
    const onOpen = vi.fn()
    render(<TaskList tasks={[task]} onOpen={onOpen} registerRow={vi.fn()} />)

    fireEvent.keyDown(screen.getAllByLabelText('workspace.openTask')[0], {
      key: 'Enter',
    })
    expect(onOpen).toHaveBeenCalledWith(task)
  })

  it('cycles sortable headers independently from the resize handle', () => {
    const onOrderingChange = vi.fn()
    const { rerender } = render(
      <TaskList
        tasks={[task]}
        ordering=""
        onOrderingChange={onOrderingChange}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )

    const assigneeHeader = screen
      .getByRole('table')
      .querySelector<HTMLElement>('th[data-column="assignee"]')!
    const sortButton = within(assigneeHeader).getByRole('button', {
      name: 'workspace.columns.assignee',
    })
    const resizeHandle = within(assigneeHeader).getByRole('slider')

    expect(assigneeHeader).toHaveAttribute('aria-sort', 'none')
    fireEvent.click(sortButton)
    expect(onOrderingChange).toHaveBeenLastCalledWith('assignee')
    fireEvent.pointerDown(resizeHandle, { clientX: 100 })
    fireEvent.pointerUp(window)
    expect(onOrderingChange).toHaveBeenCalledTimes(1)

    rerender(
      <TaskList
        tasks={[task]}
        ordering="assignee"
        onOrderingChange={onOrderingChange}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )
    expect(assigneeHeader).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(sortButton)
    expect(onOrderingChange).toHaveBeenLastCalledWith('-assignee')

    rerender(
      <TaskList
        tasks={[task]}
        ordering="-assignee"
        onOrderingChange={onOrderingChange}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )
    expect(assigneeHeader).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(sortButton)
    expect(onOrderingChange).toHaveBeenLastCalledWith('')
    expect(
      screen.getByRole('table').querySelector('th[data-column="title"]')
    ).not.toHaveAttribute('aria-sort')
  })

  it('uses the configured default and resize limits for every column', () => {
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    const expectedWidths = {
      title: [120, 60, 360],
      assignee: [60, 30, 120],
      priority: [60, 30, 120],
      startDate: [60, 30, 120],
      dueDate: [60, 30, 120],
      status: [60, 30, 120],
      taskList: [60, 30, 180],
      creator: [60, 30, 120],
      createdAt: [80, 40, 160],
    }
    const table = screen.getByRole('table')

    for (const [columnId, [defaultWidth, minWidth, maxWidth]] of Object.entries(
      expectedWidths
    )) {
      const header = table.querySelector<HTMLElement>(
        `th[data-column="${columnId}"]`
      )!
      const handle = within(header).getByRole('slider')

      expect(header).toHaveStyle({ width: `${defaultWidth}px` })
      expect(handle).toHaveAttribute('aria-valuemin', String(minWidth))
      expect(handle).toHaveAttribute('aria-valuemax', String(maxWidth))
      expect(handle).toHaveAttribute('aria-valuenow', String(defaultWidth))
    }
  })

  it('resizes a desktop column and restores the saved width', () => {
    const { unmount } = render(
      <TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    const titleHeader = screen
      .getByRole('table')
      .querySelector<HTMLElement>('th[data-column="title"]')!
    const titleHandle = within(titleHeader).getByRole('slider')

    expect(titleHeader).toHaveStyle({ width: '120px' })
    fireEvent.pointerDown(titleHandle, { clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 164 })
    fireEvent.pointerUp(window)

    expect(titleHeader).toHaveStyle({ width: '184px' })
    expect(
      JSON.parse(
        localStorage.getItem('we-meet:task-list-column-widths:v2') || '{}'
      )
    ).toMatchObject({ title: 184 })

    unmount()
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    expect(
      screen.getByRole('table').querySelector('th[data-column="title"]')
    ).toHaveStyle({ width: '184px' })
  })

  it('supports keyboard column resizing within the configured limits', () => {
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    const priorityHeader = screen
      .getByRole('table')
      .querySelector<HTMLElement>('th[data-column="priority"]')!
    const priorityHandle = within(priorityHeader).getByRole('slider')

    fireEvent.keyDown(priorityHandle, { key: 'ArrowRight' })
    expect(priorityHeader).toHaveStyle({ width: '76px' })

    for (let index = 0; index < 10; index += 1) {
      fireEvent.keyDown(priorityHandle, { key: 'ArrowLeft' })
    }
    expect(priorityHeader).toHaveStyle({ width: '30px' })
  })

  it('keeps the saved width when replacing updated time with created time', () => {
    localStorage.setItem(
      'we-meet:task-list-column-widths:v2',
      JSON.stringify({ updatedAt: 112 })
    )

    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    expect(
      screen.getByRole('table').querySelector('th[data-column="createdAt"]')
    ).toHaveStyle({ width: '112px' })
  })

  it('keeps a gutter after double-line resize handles', () => {
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    const table = screen.getByRole('table')
    const lastHeader = table.querySelector('th[data-column="createdAt"]')!
    const gutterHeader = lastHeader.nextElementSibling

    expect(gutterHeader).toHaveAttribute('aria-hidden', 'true')
    expect(gutterHeader).toHaveStyle({ width: '8px' })
    expect(within(gutterHeader as HTMLElement).queryByRole('slider')).toBeNull()
    for (const handle of within(table).getAllByRole('slider')) {
      expect(handle.children).toHaveLength(1)
    }
  })

  it('renders task-list groups and creates a task in the selected group', () => {
    const onCreateTaskInGroup = vi.fn()
    render(
      <TaskList
        tasks={[
          {
            ...task,
            group: {
              id: 'group-1',
              name: 'Analysis',
              sort_order: 0,
            },
          },
        ]}
        groups={[
          {
            id: 'group-1',
            name: 'Analysis',
            sort_order: 0,
            task_count: 1,
            can_delete: false,
            created_at: '2026-08-21T08:00:00Z',
            updated_at: '2026-08-21T08:00:00Z',
          },
        ]}
        grouped
        onOpen={vi.fn()}
        registerRow={vi.fn()}
        onCreateTaskInGroup={onCreateTaskInGroup}
      />
    )

    expect(screen.getAllByText('Analysis')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('+ groups.addTask')[0])
    expect(onCreateTaskInGroup).toHaveBeenCalledWith('group-1')

    const collapseButtons = screen.getAllByLabelText('groups.collapse')
    fireEvent.click(collapseButtons[0])
    expect(collapseButtons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByLabelText('groups.expand')).toHaveLength(2)
  })

  it('disables the delete-group action for a non-empty group', () => {
    render(
      <TaskList
        tasks={[task]}
        groups={[
          {
            id: 'group-1',
            name: 'Analysis',
            sort_order: 0,
            task_count: 1,
            can_delete: false,
            created_at: '2026-08-21T08:00:00Z',
            updated_at: '2026-08-21T08:00:00Z',
          },
        ]}
        grouped
        canManageGroups
        onOpen={vi.fn()}
        registerRow={vi.fn()}
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'groups.more' })[0])

    expect(
      screen.getByRole('menuitem', { name: 'groups.delete' })
    ).toHaveAttribute('data-disabled', 'true')
  })
})
