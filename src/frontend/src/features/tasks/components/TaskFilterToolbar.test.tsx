import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TASK_COLUMNS,
  DEFAULT_TASK_COLUMN_ORDER,
  hasActiveTaskFilters,
  type TaskWorkspaceState,
} from '../taskWorkspaceState'
import { TaskFilterToolbar } from './TaskFilterToolbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (values?.filter) return `${key}:${values.filter}`
      if (values?.field) return `${key}:${values.field}`
      if (values?.count !== undefined) return `${key}:${values.count}`
      return key
    },
  }),
}))

const state: TaskWorkspaceState = {
  scope: 'assigned',
  status: 'all',
  time: 'overdue',
  priority: 'high',
  ordering: '',
  grouping: 'none',
  columns: [...DEFAULT_TASK_COLUMNS],
  columnOrder: [...DEFAULT_TASK_COLUMN_ORDER],
  taskList: 'all',
  mode: 'list',
}

describe('TaskFilterToolbar', () => {
  it('places display settings after filters without a separator', () => {
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const priority = screen.getByLabelText('priorityFilters.label')
    const grouping = screen.getByLabelText('workspace.grouping.label')
    const ordering = screen.getByLabelText('workspace.ordering.label')
    const fieldSettings = screen.getByText('workspace.fieldSettings')

    expect(
      priority.compareDocumentPosition(grouping) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      grouping.compareDocumentPosition(ordering) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      ordering.compareDocumentPosition(fieldSettings) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(ordering).toHaveTextContent('workspace.ordering.smart')
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('changes the shared ordering state from the display settings', () => {
    const onOrderingChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={onOrderingChange}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText('workspace.ordering.label'))
    fireEvent.click(
      screen.getByRole('option', {
        name: 'workspace.ordering.dueDateAsc',
      })
    )

    expect(onOrderingChange).toHaveBeenCalledWith('due_date')
  })

  it('summarizes active filters and removes each one independently', () => {
    const onStatusChange = vi.fn()
    const onTimeChange = vi.fn()
    const onPriorityChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={onStatusChange}
        onTimeChange={onTimeChange}
        onPriorityChange={onPriorityChange}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(
      screen.getByText('workspace.filteredResultCount:7')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'workspace.removeFilter:workspace.statusOptions.all',
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'workspace.removeFilter:timeFilters.overdue',
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'workspace.removeFilter:priorityFilters.high',
      })
    )

    expect(onStatusChange).toHaveBeenCalledWith('open')
    expect(onTimeChange).toHaveBeenCalledWith('all')
    expect(onPriorityChange).toHaveBeenCalledWith('all')
  })

  it('hides filter actions when the current state uses mode defaults', () => {
    const defaultState = {
      ...state,
      status: 'open' as const,
      time: 'all' as const,
      priority: 'all' as const,
    }
    render(
      <TaskFilterToolbar
        state={defaultState}
        resultCount={12}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(hasActiveTaskFilters(defaultState)).toBe(false)
    expect(
      screen.queryByRole('button', { name: 'workspace.clearFilters' })
    ).not.toBeInTheDocument()
  })

  it('uses all statuses as the board default', () => {
    expect(
      hasActiveTaskFilters({
        ...state,
        mode: 'board',
        status: 'all',
        time: 'all',
        priority: 'all',
      })
    ).toBe(false)
  })

  it('closes field settings after an outside press', () => {
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const summary = screen.getByText('workspace.fieldSettings')
    const picker = summary.closest('details')!
    fireEvent.click(summary)
    expect(picker).toHaveAttribute('open')

    fireEvent.pointerDown(document.body)
    expect(picker).not.toHaveAttribute('open')
  })

  it('resets fields to the defaults imposed by the current view', () => {
    const onColumnsChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={{
          ...state,
          scope: 'created',
          taskList: 'list-1',
          columns: ['title', 'completedAt'],
        }}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={onColumnsChange}
        onClear={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'workspace.resetFields' })
    )

    expect(onColumnsChange).toHaveBeenCalledWith(
      DEFAULT_TASK_COLUMNS.filter(
        (column) => column !== 'creator' && column !== 'taskList'
      ),
      DEFAULT_TASK_COLUMN_ORDER
    )
  })

  it('reorders fields with the drag-handle keyboard controls', () => {
    const onColumnsChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={onColumnsChange}
        onClear={vi.fn()}
      />
    )

    fireEvent.keyDown(
      screen.getByRole('button', {
        name: 'workspace.moveField:workspace.columns.dueDate',
      }),
      { key: 'ArrowUp' }
    )

    expect(onColumnsChange).toHaveBeenCalledWith(
      [
        'title',
        'assignee',
        'priority',
        'dueDate',
        'startDate',
        'taskList',
        'creator',
        'createdAt',
      ],
      [
        'title',
        'assignee',
        'priority',
        'dueDate',
        'startDate',
        'taskList',
        'customGroup',
        'creator',
        'createdAt',
        'completedAt',
      ]
    )
  })

  it('reorders fields by dragging a handle onto another field', () => {
    const onColumnsChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={onColumnsChange}
        onClear={vi.fn()}
      />
    )
    const dataTransfer = {
      effectAllowed: '',
      setData: vi.fn(),
      getData: vi.fn(() => 'dueDate'),
    }

    fireEvent.dragStart(
      screen.getByRole('button', {
        name: 'workspace.moveField:workspace.columns.dueDate',
      }),
      { dataTransfer }
    )
    fireEvent.drop(
      screen.getByText('workspace.columns.assignee').parentElement!,
      { dataTransfer }
    )

    expect(onColumnsChange.mock.calls[0][1].slice(0, 4)).toEqual([
      'title',
      'dueDate',
      'assignee',
      'priority',
    ])
  })

  it('previews the animated drop position before committing the order', () => {
    const onColumnsChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={onColumnsChange}
        onClear={vi.fn()}
      />
    )
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn(() => 'dueDate'),
    }
    const dueDateRow = screen.getByText('workspace.columns.dueDate')
      .parentElement!
    const assigneeRow = screen.getByText('workspace.columns.assignee')
      .parentElement!
    vi.spyOn(assigneeRow, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 32,
      left: 0,
      right: 240,
      width: 240,
      height: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.dragStart(
      screen.getByRole('button', {
        name: 'workspace.moveField:workspace.columns.dueDate',
      }),
      { dataTransfer }
    )
    expect(dueDateRow).toHaveAttribute('data-dragging')

    fireEvent.dragOver(assigneeRow, { dataTransfer, clientY: 4 })

    expect(assigneeRow).toHaveAttribute('data-drop-position', 'before')
    expect(
      screen
        .getAllByText(/^workspace\.columns\./)
        .slice(0, 4)
        .map((element) => element.textContent)
    ).toEqual([
      'workspace.columns.title',
      'workspace.columns.dueDate',
      'workspace.columns.assignee',
      'workspace.columns.priority',
    ])

    fireEvent.drop(assigneeRow, { dataTransfer })

    expect(dueDateRow).toHaveAttribute('data-dropped')
    expect(onColumnsChange.mock.calls[0][1].slice(0, 4)).toEqual([
      'title',
      'dueDate',
      'assignee',
      'priority',
    ])
  })

  it('shows a hidden field at its configured position', () => {
    const onColumnsChange = vi.fn()
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={onColumnsChange}
        onClear={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'workspace.showField:workspace.columns.customGroup',
      })
    )

    expect(onColumnsChange).toHaveBeenCalledWith(
      [
        'title',
        'assignee',
        'priority',
        'startDate',
        'dueDate',
        'taskList',
        'customGroup',
        'creator',
        'createdAt',
      ],
      DEFAULT_TASK_COLUMN_ORDER
    )
  })

  it('locks only the task title and lets users toggle view-default fields', () => {
    render(
      <TaskFilterToolbar
        state={{
          ...state,
          scope: 'created',
          status: 'completed',
          taskList: 'list-1',
          columns: [...DEFAULT_TASK_COLUMNS, 'completedAt'],
        }}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onOrderingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const title = screen.getByRole('button', {
      name: 'workspace.fieldLocked:workspace.columns.title',
    })
    const creator = screen.getByRole('button', {
      name: 'workspace.hideField:workspace.columns.creator',
    })
    const completedAt = screen.getByRole('button', {
      name: 'workspace.hideField:workspace.columns.completedAt',
    })
    const taskList = screen.getByRole('button', {
      name: 'workspace.hideField:workspace.columns.taskList',
    })
    expect(title).toBeDisabled()
    expect(creator).toBeEnabled()
    expect(taskList).toBeEnabled()
    expect(completedAt).toBeEnabled()
  })
})
