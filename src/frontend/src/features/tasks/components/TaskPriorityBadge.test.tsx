import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TaskPriorityBadge } from './TaskPriorityBadge'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('TaskPriorityBadge', () => {
  it('renders a translated semantic badge for a selected priority', () => {
    render(<TaskPriorityBadge priority="urgent" />)

    expect(screen.getByText('priorities.urgent')).toHaveAttribute(
      'data-priority',
      'urgent'
    )
  })

  it('does not render the no-priority value', () => {
    const { container } = render(<TaskPriorityBadge priority="none" />)

    expect(container).toBeEmptyDOMElement()
  })
})
