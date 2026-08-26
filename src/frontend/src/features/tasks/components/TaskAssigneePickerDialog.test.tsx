import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskUser } from '../api/ApiTask'
import { TaskAssigneePickerDialog } from './TaskAssigneePickerDialog'

interface PickerProps {
  includeSelf?: boolean
  selected: Map<string, string>
  onToggle: (id: string, label: string, avatarUrl?: string) => void
}

const pickerState = vi.hoisted(() => ({ props: null as PickerProps | null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}))

vi.mock('@/features/contacts', () => ({
  DirectoryMultiPicker: (props: PickerProps) => {
    pickerState.props = props
    return (
      <button
        type="button"
        onClick={() => props.onToggle('assignee-2', 'Assignee Two', '/two.png')}
      >
        add-assignee
      </button>
    )
  },
}))

const initialAssignee: ApiTaskUser = {
  id: 'assignee-1',
  full_name: 'Assignee One',
  short_name: null,
  avatar_url: '/one.png',
}

describe('TaskAssigneePickerDialog', () => {
  it('confirms multiple equally responsible assignees', () => {
    const onConfirm = vi.fn()
    render(
      <TaskAssigneePickerDialog
        initial={[initialAssignee]}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    )

    expect(pickerState.props?.includeSelf).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'add-assignee' }))
    fireEvent.click(screen.getByTestId('task-assignee-confirm'))

    expect(onConfirm).toHaveBeenCalledWith([
      initialAssignee,
      {
        id: 'assignee-2',
        full_name: 'Assignee Two',
        short_name: null,
        avatar_url: '/two.png',
      },
    ])
  })
})
