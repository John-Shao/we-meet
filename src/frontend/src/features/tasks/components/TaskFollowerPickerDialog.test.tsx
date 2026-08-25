import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskUser } from '../api/ApiTask'
import { TaskFollowerPickerDialog } from './TaskFollowerPickerDialog'

interface PickerProps {
  includeSelf?: boolean
  selected: Map<string, string>
  excludeIds?: Set<string>
  onToggle: (id: string, label: string, avatarUrl?: string) => void
}

const pickerState = vi.hoisted(() => ({
  props: null as PickerProps | null,
}))

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
        onClick={() => props.onToggle('follower-2', 'Follower Two', '/two.png')}
      >
        add-follower
      </button>
    )
  },
}))

const initialFollower: ApiTaskUser = {
  id: 'follower-1',
  full_name: 'Follower One',
  short_name: null,
  avatar_url: '/one.png',
}

describe('TaskFollowerPickerDialog', () => {
  it('uses the shared multi-picker and confirms all selected followers', () => {
    const onConfirm = vi.fn()
    const excluded = new Set(['existing-follower'])
    render(
      <TaskFollowerPickerDialog
        initial={[initialFollower]}
        excludeIds={excluded}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    )

    expect(pickerState.props?.includeSelf).toBe(true)
    expect(pickerState.props?.excludeIds).toBe(excluded)
    expect([...pickerState.props!.selected.entries()]).toEqual([
      ['follower-1', 'Follower One'],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'add-follower' }))
    expect([...pickerState.props!.selected.keys()]).toEqual([
      'follower-1',
      'follower-2',
    ])

    fireEvent.click(screen.getByTestId('task-follower-confirm'))
    expect(onConfirm).toHaveBeenCalledWith([
      initialFollower,
      {
        id: 'follower-2',
        full_name: 'Follower Two',
        short_name: null,
        avatar_url: '/two.png',
      },
    ])
  })
})
