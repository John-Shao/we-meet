import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiTask } from '../api/ApiTask'
import { formatTaskCreatedAt } from '../taskDateFormat'
import { TaskList } from './TaskList'

const mutate = vi.fn()
const mutateAsync = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('./TaskAssigneePickerDialog', () => ({
  TaskAssigneePickerDialog: ({
    onConfirm,
    onClose,
  }: {
    onConfirm: (members: NonNullable<ApiTask['assignees']>) => void
    onClose: () => void
  }) => (
    <div role="dialog">
      <button
        type="button"
        onClick={() =>
          onConfirm([
            {
              id: 'member-2',
              full_name: 'Jordan',
              short_name: null,
              avatar_url: '/jordan.png',
            },
          ])
        }
      >
        Pick member
      </button>
      <button type="button" onClick={onClose}>
        Cancel picker
      </button>
    </div>
  ),
}))

vi.mock('../api/fetchTasks', () => ({
  usePatchTask: () => ({ mutate, mutateAsync, isPending: false }),
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
  followers: [],
  status: 'todo',
  priority: 'high',
  task_list: {
    id: 'list-1',
    name: 'Release work',
    color: 'blue',
  },
  group: null,
  parent_id: null,
  depth: 0,
  ancestor_path: [{ id: 'task-1', title: 'Prepare release', depth: 0 }],
  descendant_progress: { completed: 0, total: 0 },
  can_create_subtasks: false,
  position: 0,
  start_date: '2026-08-21',
  due_date: '2026-08-22',
  completed_at: null,
  source_action_item_id: null,
  source_room_id: 'meeting-1',
  source_room_name: 'Weekly sync',
  can_edit: false,
  can_update_status: true,
  can_delete: false,
  can_comment: true,
  can_manage_attachments: true,
  can_manage_followers: true,
  is_following: false,
  time_state: null,
  created_at: '2026-08-21T08:00:00Z',
  updated_at: '2026-08-21T09:00:00Z',
}

beforeEach(() => {
  mutate.mockReset()
  mutateAsync.mockReset()
  mutateAsync.mockResolvedValue({ ...task, status: 'completed' })
})

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
      'workspace.columns.taskList',
      'workspace.columns.creator',
      'workspace.columns.createdAt',
    ])
    expect(screen.queryByText('statuses.todo')).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('workspace.quickComplete')).toHaveLength(2)
    expect(screen.getAllByText('Prepare release')).toHaveLength(2)
    expect(screen.getAllByText('priorities.high')).toHaveLength(2)
    expect(within(table).getByText('Aug 21')).toBeInTheDocument()
    expect(within(table).getByText('Aug 22')).toBeInTheDocument()
    expect(
      within(table).getAllByText(formatTaskCreatedAt(task.created_at))
    ).toHaveLength(1)
    expect(
      within(table).queryByText(formatTaskCreatedAt(task.updated_at))
    ).not.toBeInTheDocument()
    expect(container.querySelector('img[src="/assignee.png"]')).toBeTruthy()
    expect(container.querySelector('img[src="/creator.png"]')).toBeTruthy()
    expect(within(table).getByText('Release work')).toBeInTheDocument()
  })

  it('keeps only the four decision columns while the detail panel is open', () => {
    render(
      <TaskList tasks={[task]} compact onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual([
      'workspace.columns.title',
      'workspace.columns.assignee',
      'workspace.columns.priority',
      'workspace.columns.dueDate',
    ])
  })

  it('shows the complete ancestor chain for a subtask row', () => {
    const subtask = {
      ...task,
      parent_id: 'parent-1',
      depth: 2,
      ancestor_path: [
        { id: 'root-1', title: 'Release', depth: 0 },
        { id: 'parent-1', title: 'Backend', depth: 1 },
        { id: task.id, title: task.title, depth: 2 },
      ],
    }

    render(
      <TaskList tasks={[subtask]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    expect(
      screen.getAllByText('Release › Backend › Prepare release')
    ).toHaveLength(2)
  })

  it('collapses and expands nested task rows with progress like Feishu', () => {
    const parent: ApiTask = {
      ...task,
      id: 'parent-1',
      title: 'Release',
      ancestor_path: [{ id: 'parent-1', title: 'Release', depth: 0 }],
      descendant_progress: { completed: 0, total: 1 },
    }
    const child: ApiTask = {
      ...task,
      id: 'child-1',
      title: 'Backend',
      parent_id: parent.id,
      depth: 1,
      ancestor_path: [
        { id: parent.id, title: parent.title, depth: 0 },
        { id: 'child-1', title: 'Backend', depth: 1 },
      ],
    }

    const { container, rerender } = render(
      <TaskList
        tasks={[parent, child]}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )

    expect(screen.queryByText('Backend')).not.toBeInTheDocument()
    expect(screen.getAllByText('0/1')).toHaveLength(2)
    fireEvent.click(
      screen.getAllByRole('button', { name: 'subtasks.expandInList' })[0]
    )
    expect(screen.getAllByText('Backend')).toHaveLength(2)
    expect(screen.queryByText('Release › Backend')).not.toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'subtasks.collapseInList' })[0]
    )
    expect(screen.queryByText('Backend')).not.toBeInTheDocument()

    rerender(
      <TaskList
        tasks={[parent, child]}
        selectedTaskId={child.id}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )
    expect(screen.getAllByText('Backend')).toHaveLength(2)
    expect(container.querySelectorAll('[data-selected]')).toHaveLength(2)
  })

  it('quickly completes and reopens a task without opening its details', async () => {
    const onOpen = vi.fn()
    render(<TaskList tasks={[task]} onOpen={onOpen} registerRow={vi.fn()} />)

    const completeButton = screen.getAllByLabelText(
      'workspace.quickComplete'
    )[0]
    fireEvent.mouseEnter(completeButton.parentElement!)
    expect(screen.getByText('actions.to_completed')).toBeInTheDocument()
    fireEvent.mouseLeave(completeButton.parentElement!)
    fireEvent.click(completeButton)

    expect(onOpen).not.toHaveBeenCalled()
    expect(mutateAsync).toHaveBeenCalledWith({
      taskId: task.id,
      patch: { status: 'completed' },
    })
    await waitFor(() =>
      expect(screen.getAllByLabelText('workspace.quickReopen')).toHaveLength(2)
    )
    expect(
      screen
        .getAllByText('Prepare release')
        .every((title) => title.closest('[data-completed]'))
    ).toBe(true)

    mutateAsync.mockResolvedValueOnce({ ...task, status: 'todo' })
    fireEvent.click(screen.getAllByLabelText('workspace.quickReopen')[0])
    expect(mutateAsync).toHaveBeenLastCalledWith({
      taskId: task.id,
      patch: { status: 'todo' },
    })
    expect(
      screen
        .getAllByText('Prepare release')
        .every((title) => !title.closest('[data-completed]'))
    ).toBe(true)
  })

  it('confirms before completing a task with unfinished descendants', async () => {
    const onConfirmCompleteWithOpenSubtasks = vi.fn().mockResolvedValue(false)
    render(
      <TaskList
        tasks={[
          {
            ...task,
            descendant_progress: { completed: 1, total: 3 },
          },
        ]}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
        onConfirmCompleteWithOpenSubtasks={onConfirmCompleteWithOpenSubtasks}
      />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByLabelText(
        'workspace.quickComplete'
      )
    )

    await waitFor(() =>
      expect(onConfirmCompleteWithOpenSubtasks).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id })
      )
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('restores the previous status and reports a failed quick action', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('network error'))
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    fireEvent.click(screen.getAllByLabelText('workspace.quickComplete')[0])

    expect(await screen.findByRole('alert')).toHaveTextContent('error')
    expect(screen.getAllByLabelText('workspace.quickComplete')).toHaveLength(2)
  })

  it('shows status without allowing the quick action when permission is missing', () => {
    render(
      <TaskList
        tasks={[{ ...task, can_update_status: false }]}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )

    const statusButtons = screen.getAllByLabelText(
      'statuses.todo: Prepare release'
    )
    expect(statusButtons).toHaveLength(2)
    expect(statusButtons[0]).toBeDisabled()
    fireEvent.click(statusButtons[0])
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('edits a task title in the table with Enter without opening details', async () => {
    const onOpen = vi.fn()
    const editableTask = { ...task, can_edit: true }
    mutateAsync.mockResolvedValueOnce({
      ...editableTask,
      title: 'Ship release',
      updated_at: '2026-08-21T10:00:00Z',
    })
    render(
      <TaskList tasks={[editableTask]} onOpen={onOpen} registerRow={vi.fn()} />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.title',
      })
    )
    const input = within(screen.getByRole('table')).getByRole('textbox', {
      name: 'actions.edit workspace.columns.title',
    })
    fireEvent.change(input, { target: { value: '  Ship release  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { title: 'Ship release' },
      })
    )
    expect(onOpen).not.toHaveBeenCalled()
    expect(await screen.findAllByText('Ship release')).toHaveLength(2)
  })

  it('cancels a table title edit with Escape', () => {
    const editableTask = { ...task, can_edit: true }
    render(
      <TaskList tasks={[editableTask]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.title',
      })
    )
    const input = within(screen.getByRole('table')).getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Do not save' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(mutateAsync).not.toHaveBeenCalled()
    expect(
      within(screen.getByRole('table')).getByText(task.title)
    ).toBeVisible()
  })

  it('presents non-title editable cells with their control affordance', () => {
    const editableTask = { ...task, can_edit: true }
    render(
      <TaskList tasks={[editableTask]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    const table = within(screen.getByRole('table'))
    for (const column of ['assignee', 'priority', 'taskList']) {
      const button = table.getByRole('button', {
        name: `actions.edit workspace.columns.${column}`,
      })
      expect(button).toHaveAttribute('data-select', 'true')
      expect(button.querySelector('[data-inline-select-chevron]')).toBeTruthy()
    }
    for (const column of ['startDate', 'dueDate']) {
      const button = table.getByRole('button', {
        name: `actions.edit workspace.columns.${column}`,
      })
      expect(button).toHaveAttribute('data-date', 'true')
      expect(button.querySelector('[data-inline-date-icon]')).toBeTruthy()
    }
    expect(
      table.getByRole('button', {
        name: 'actions.edit workspace.columns.title',
      })
    ).not.toHaveAttribute('data-select')
  })

  it('edits priority and dates from their table cells', async () => {
    const editableTask = { ...task, can_edit: true }
    mutateAsync
      .mockResolvedValueOnce({
        ...editableTask,
        priority: 'urgent',
        updated_at: '2026-08-21T10:00:00Z',
      })
      .mockResolvedValueOnce({
        ...editableTask,
        priority: 'urgent',
        due_date: '2026-08-25',
        updated_at: '2026-08-21T11:00:00Z',
      })
    render(
      <TaskList tasks={[editableTask]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.priority',
      })
    )
    fireEvent.click(
      screen.getByRole('option', {
        name: 'priorities.urgent',
      })
    )
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenLastCalledWith({
        taskId: task.id,
        patch: { priority: 'urgent' },
      })
    )
    await screen.findAllByText('priorities.urgent')

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.dueDate',
      })
    )
    const dateInput = within(screen.getByRole('table')).getByLabelText(
      'workspace.columns.dueDate'
    )
    fireEvent.change(dateInput, { target: { value: '2026-08-25' } })
    fireEvent.blur(dateInput)

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenLastCalledWith({
        taskId: task.id,
        patch: { due_date: '2026-08-25' },
      })
    )
  })

  it('closes a table select editor when clicking outside', async () => {
    const editableTask = { ...task, can_edit: true }
    render(
      <TaskList tasks={[editableTask]} onOpen={vi.fn()} registerRow={vi.fn()} />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.priority',
      })
    )
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    fireEvent.pointerUp(document.body)
    fireEvent.click(document.body)

    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    )
    expect(mutateAsync).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        within(screen.getByRole('table')).getByRole('button', {
          name: 'actions.edit workspace.columns.priority',
        })
      ).toBeInTheDocument()
    )
  })

  it('reassigns a task from its assignee cell', async () => {
    const editableTask = { ...task, can_edit: true }
    mutateAsync.mockResolvedValueOnce({
      ...editableTask,
      assignee: {
        id: 'member-2',
        full_name: 'Jordan',
        short_name: null,
        avatar_url: '/jordan.png',
      },
      assignees: [
        {
          id: 'member-2',
          full_name: 'Jordan',
          short_name: null,
          avatar_url: '/jordan.png',
        },
      ],
      updated_at: '2026-08-21T10:00:00Z',
    })
    const onOpen = vi.fn()
    render(
      <TaskList tasks={[editableTask]} onOpen={onOpen} registerRow={vi.fn()} />
    )

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'actions.edit workspace.columns.assignee',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pick member' }))

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: task.id,
        patch: { assignee_ids: ['member-2'] },
      })
    )
    expect(onOpen).not.toHaveBeenCalled()
    expect(await screen.findAllByText('Jordan')).toHaveLength(2)
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

  it('navigates and controls the task tree from the keyboard', async () => {
    const parent: ApiTask = {
      ...task,
      id: 'parent-1',
      title: 'Release',
      ancestor_path: [{ id: 'parent-1', title: 'Release', depth: 0 }],
      descendant_progress: { completed: 0, total: 1 },
    }
    const child: ApiTask = {
      ...task,
      id: 'child-1',
      title: 'Backend',
      parent_id: parent.id,
      depth: 1,
      ancestor_path: [
        { id: parent.id, title: parent.title, depth: 0 },
        { id: 'child-1', title: 'Backend', depth: 1 },
      ],
    }
    render(
      <TaskList
        tasks={[parent, child]}
        onOpen={vi.fn()}
        registerRow={vi.fn()}
      />
    )

    const table = screen.getByRole('table')
    const parentRow = within(table).getByLabelText('workspace.openTask')
    parentRow.focus()
    fireEvent.keyDown(parentRow, { key: 'ArrowRight' })

    const rows = within(table).getAllByLabelText('workspace.openTask')
    expect(rows).toHaveLength(2)
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(rows[1]).toHaveFocus()

    fireEvent.keyDown(rows[1], { key: ' ' })
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: child.id,
        patch: { status: 'completed' },
      })
    )

    fireEvent.keyDown(rows[0], { key: 'ArrowLeft' })
    expect(within(table).getAllByLabelText('workspace.openTask')).toHaveLength(
      1
    )
  })

  it('shares a task from its row context menu without opening details', () => {
    const onOpen = vi.fn()
    const onShare = vi.fn()
    render(
      <TaskList
        tasks={[task]}
        onOpen={onOpen}
        onShare={onShare}
        registerRow={vi.fn()}
      />
    )

    fireEvent.contextMenu(
      within(screen.getByRole('table')).getByLabelText('workspace.openTask'),
      { clientX: 120, clientY: 80 }
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'share.action' }))

    expect(onShare).toHaveBeenCalledWith(task)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows icons and deletes an editable task from the row context menu', () => {
    const onOpen = vi.fn()
    const onShare = vi.fn()
    const onDeleteTask = vi.fn()
    render(
      <TaskList
        tasks={[{ ...task, can_delete: true }]}
        onOpen={onOpen}
        onShare={onShare}
        onDeleteTask={onDeleteTask}
        registerRow={vi.fn()}
      />
    )

    fireEvent.contextMenu(
      within(screen.getByRole('table')).getByLabelText('workspace.openTask')
    )
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
    expect(menu.querySelectorAll('svg')).toHaveLength(2)
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'actions.delete' })
    )

    expect(onDeleteTask).toHaveBeenCalledWith({ ...task, can_delete: true })
    expect(onShare).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
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
      title: [360, 160, 720],
      assignee: [160, 96, 240],
      priority: [100, 72, 140],
      startDate: [110, 88, 150],
      dueDate: [110, 88, 150],
      taskList: [150, 96, 240],
      creator: [140, 96, 220],
      createdAt: [170, 128, 220],
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

    expect(titleHeader).toHaveStyle({ width: '360px' })
    fireEvent.pointerDown(titleHandle, { clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 164 })
    fireEvent.pointerUp(window)

    expect(titleHeader).toHaveStyle({ width: '424px' })
    expect(
      JSON.parse(
        localStorage.getItem('we-meet:task-list-column-widths:v3') || '{}'
      )
    ).toMatchObject({ title: 424 })

    unmount()
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    expect(
      screen.getByRole('table').querySelector('th[data-column="title"]')
    ).toHaveStyle({ width: '424px' })
  })

  it('supports keyboard column resizing within the configured limits', () => {
    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    const priorityHeader = screen
      .getByRole('table')
      .querySelector<HTMLElement>('th[data-column="priority"]')!
    const priorityHandle = within(priorityHeader).getByRole('slider')

    fireEvent.keyDown(priorityHandle, { key: 'ArrowRight' })
    expect(priorityHeader).toHaveStyle({ width: '116px' })

    for (let index = 0; index < 10; index += 1) {
      fireEvent.keyDown(priorityHandle, { key: 'ArrowLeft' })
    }
    expect(priorityHeader).toHaveStyle({ width: '72px' })
  })

  it('restores a saved created-time column width', () => {
    localStorage.setItem(
      'we-meet:task-list-column-widths:v3',
      JSON.stringify({ createdAt: 192 })
    )

    render(<TaskList tasks={[task]} onOpen={vi.fn()} registerRow={vi.fn()} />)

    expect(
      screen.getByRole('table').querySelector('th[data-column="createdAt"]')
    ).toHaveStyle({ width: '192px' })
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
    const groupedTable = screen.getByRole('table')
    expect(
      within(groupedTable).queryByRole('columnheader', {
        name: 'workspace.columns.taskList',
      })
    ).not.toBeInTheDocument()
    const groupedTaskRow =
      within(groupedTable).getByLabelText('workspace.openTask')
    expect(groupedTaskRow).toHaveAttribute('data-grouped', 'true')
    expect(groupedTaskRow).toHaveAttribute('data-group-last', 'true')
    expect(
      groupedTaskRow.querySelector('[data-status="todo"]')
    ).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('+ groups.addTask')[0])
    expect(onCreateTaskInGroup).toHaveBeenCalledWith('group-1')

    const collapseButtons = screen.getAllByLabelText('groups.collapse')
    fireEvent.click(collapseButtons[0])
    expect(collapseButtons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByLabelText('groups.expand')).toHaveLength(2)
  })

  it('shows an actionable drop target for an empty task group', () => {
    render(
      <TaskList
        tasks={[]}
        groups={[
          {
            id: 'group-1',
            name: 'Development',
            sort_order: 0,
            task_count: 0,
            can_delete: true,
            created_at: '2026-08-21T08:00:00Z',
            updated_at: '2026-08-21T08:00:00Z',
          },
        ]}
        grouped
        onOpen={vi.fn()}
        registerRow={vi.fn()}
        onCreateTaskInGroup={vi.fn()}
      />
    )

    expect(screen.getAllByText('groups.empty')).toHaveLength(2)
    expect(screen.getAllByText('groups.taskCount')).toHaveLength(2)

    const desktopDropTarget = within(screen.getByRole('table'))
      .getByText('groups.empty')
      .closest('tr')!
    fireEvent.dragOver(desktopDropTarget)
    expect(desktopDropTarget).toHaveAttribute('data-drag-over', 'true')
    fireEvent.dragLeave(desktopDropTarget)
    expect(desktopDropTarget).not.toHaveAttribute('data-drag-over')
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
