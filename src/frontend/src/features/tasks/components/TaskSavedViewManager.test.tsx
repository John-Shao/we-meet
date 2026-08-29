import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskSavedView } from '../api/ApiTask'
import { TaskSavedViewManager } from './TaskSavedViewManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const view: ApiTaskSavedView = {
  id: 'view-1',
  name: 'Urgent this week',
  config: {
    version: 1,
    scope: 'assigned',
    status: 'open',
    time: 'all',
    priority: 'urgent',
    task_list: 'all',
    ordering: 'due_date',
    view: 'list',
  },
  position: 0,
  is_pinned: false,
  is_default: false,
  invalid_task_list: false,
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
}

describe('TaskSavedViewManager', () => {
  it('keeps unpinned views manageable', () => {
    const onOpen = vi.fn()
    const onTogglePinned = vi.fn()
    const onSetDefault = vi.fn()
    render(
      <TaskSavedViewManager
        views={[view]}
        onOpen={onOpen}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onTogglePinned={onTogglePinned}
        onSetDefault={onSetDefault}
        onMove={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: view.name }))
    expect(onOpen).toHaveBeenCalledWith(view)
    fireEvent.click(screen.getByRole('button', { name: 'savedViews.pinNamed' }))
    expect(onTogglePinned).toHaveBeenCalledWith(view)
    fireEvent.click(
      screen.getByRole('button', { name: 'savedViews.defaultNamed' })
    )
    expect(onSetDefault).toHaveBeenCalledWith(view)
  })
})
