import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
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
  taskList: 'all',
  mode: 'list',
}

describe('TaskFilterToolbar', () => {
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
})
