import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TASK_COLUMNS,
  hasActiveTaskFilters,
  type TaskWorkspaceState,
} from '../taskWorkspaceState'
import { TaskFilterToolbar } from './TaskFilterToolbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (values?.filter) return `${key}:${values.filter}`
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
  taskList: 'all',
  mode: 'list',
}

describe('TaskFilterToolbar', () => {
  it('places display settings after filters with a vertical separator', () => {
    render(
      <TaskFilterToolbar
        state={state}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const priority = screen.getByLabelText('priorityFilters.label')
    const separator = screen.getByRole('separator')
    const grouping = screen.getByLabelText('workspace.grouping.label')
    const fieldSettings = screen.getByText('workspace.fieldSettings')

    expect(
      priority.compareDocumentPosition(separator) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      separator.compareDocumentPosition(grouping) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      grouping.compareDocumentPosition(fieldSettings) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
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

  it('reflects fields fixed by a predefined view', () => {
    render(
      <TaskFilterToolbar
        state={{
          ...state,
          scope: 'created',
          columns: [...DEFAULT_TASK_COLUMNS, 'completedAt'],
        }}
        resultCount={7}
        onStatusChange={vi.fn()}
        onTimeChange={vi.fn()}
        onPriorityChange={vi.fn()}
        onGroupingChange={vi.fn()}
        onColumnsChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const creator = screen.getByRole('checkbox', {
      name: 'workspace.columns.creator',
    })
    const completedAt = screen.getByRole('checkbox', {
      name: 'workspace.columns.completedAt',
    })
    expect(creator).not.toBeChecked()
    expect(creator).toBeDisabled()
    expect(completedAt).toBeChecked()
    expect(completedAt).toBeEnabled()
  })
})
