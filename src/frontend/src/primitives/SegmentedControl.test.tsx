import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SegmentedControl } from './SegmentedControl'

describe('SegmentedControl', () => {
  it('exposes selected tab semantics and reports the next value', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        ariaLabel="Calendar mode"
        value="calendar"
        onChange={onChange}
        items={[
          { id: 'calendar', label: 'Calendar' },
          { id: 'rooms', label: 'Meeting rooms' },
        ]}
      />
    )

    expect(screen.getByRole('tablist', { name: 'Calendar mode' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Calendar' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Meeting rooms' }))
    expect(onChange).toHaveBeenCalledWith('rooms')
  })

  it('supports a compact pill appearance for dense category filters', () => {
    render(
      <SegmentedControl
        ariaLabel="Search category"
        appearance="pill"
        density="compact"
        value="all"
        onChange={() => undefined}
        items={[
          { id: 'all', label: 'All' },
          { id: 'people', label: 'People' },
        ]}
      />
    )

    expect(
      screen.getByRole('tablist', { name: 'Search category' })
    ).toHaveAttribute('data-appearance', 'pill')
  })
})
