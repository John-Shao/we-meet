import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TaskLabelBadge } from './TaskLabelBadge'

describe('TaskLabelBadge', () => {
  it('renders the label name and semantic color marker', () => {
    render(
      <TaskLabelBadge
        label={{
          id: 'label-1',
          name: 'Customer',
          color: 'purple',
          can_manage: true,
          created_at: '2026-08-21T10:00:00Z',
          updated_at: '2026-08-21T10:00:00Z',
        }}
      />
    )

    expect(screen.getByText('Customer')).toHaveAttribute(
      'data-label-color',
      'purple'
    )
  })
})
