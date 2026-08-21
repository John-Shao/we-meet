import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiTaskLabel } from '../api/ApiTask'
import { TaskLabelSelector } from './TaskLabelSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const labels: ApiTaskLabel[] = [
  {
    id: 'customer',
    name: 'Customer',
    color: 'blue',
    can_manage: true,
    created_at: '2026-08-21T10:00:00Z',
    updated_at: '2026-08-21T10:00:00Z',
  },
  {
    id: 'release',
    name: 'Release',
    color: 'red',
    can_manage: true,
    created_at: '2026-08-21T10:00:00Z',
    updated_at: '2026-08-21T10:00:00Z',
  },
]

describe('TaskLabelSelector', () => {
  it('adds a selected label', () => {
    const onChange = vi.fn()
    render(
      <TaskLabelSelector labels={labels} selectedIds={[]} onChange={onChange} />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Customer' }))

    expect(onChange).toHaveBeenCalledWith(['customer'])
  })

  it('keeps selected labels removable while disabling additions at the limit', () => {
    render(
      <TaskLabelSelector
        labels={labels}
        selectedIds={['customer']}
        onChange={vi.fn()}
        max={1}
      />
    )

    expect(screen.getByRole('checkbox', { name: 'Customer' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Release' })).toBeDisabled()
  })
})
