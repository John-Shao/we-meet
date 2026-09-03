import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskGroup } from '../api/ApiTask'
import { TaskGroupManager } from './TaskGroupManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const group = (
  id: string,
  name: string,
  overrides: Partial<ApiTaskGroup> = {}
): ApiTaskGroup => ({
  id,
  name,
  sort_order: 0,
  task_count: 0,
  can_delete: true,
  can_manage: true,
  created_at: `2026-08-29T00:00:0${id}.000Z`,
  updated_at: '2026-08-29T00:00:00.000Z',
  ...overrides,
})

describe('TaskGroupManager', () => {
  it('supports creation, rename, deletion, and adjacent reordering', () => {
    const groups = [
      group('1', 'Design'),
      group('2', 'Development', { sort_order: 1 }),
    ]
    const onCreate = vi.fn()
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const onMove = vi.fn()
    render(
      <TaskGroupManager
        groups={groups}
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
        onMove={onMove}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'groups.create' }))
    fireEvent.click(
      screen.getAllByRole('button', { name: 'groups.renameNamed' })[0]
    )
    fireEvent.click(
      screen.getAllByRole('button', { name: 'groups.deleteNamed' })[0]
    )
    fireEvent.click(
      screen.getAllByRole('button', { name: 'groups.moveDownNamed' })[0]
    )

    expect(onCreate).toHaveBeenCalledOnce()
    expect(onRename).toHaveBeenCalledWith(groups[0])
    expect(onDelete).toHaveBeenCalledWith(groups[0])
    expect(onMove).toHaveBeenCalledWith(groups[0], 1)
  })

  it('disables editing, deletion, and swaps across read-only groups', () => {
    render(
      <TaskGroupManager
        groups={[
          group('1', 'Mine'),
          group('2', 'Shared', { can_manage: false }),
          group('3', 'Used', { task_count: 2, can_delete: false }),
        ]}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
      />
    )

    expect(
      screen.getAllByRole('button', { name: 'groups.moveDownNamed' })[0]
    ).toBeDisabled()
    expect(
      screen.getAllByRole('button', { name: 'groups.renameNamed' })[1]
    ).toBeDisabled()
    expect(
      screen.getAllByRole('button', { name: 'groups.deleteNamed' })[2]
    ).toBeDisabled()
  })
})
