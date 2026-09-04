import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IconButton, IconToggleButton } from './IconButton'

describe('IconButton primitives', () => {
  it('uses the required label as its accessible name', () => {
    render(
      <IconButton label="Previous day">
        <span aria-hidden="true">←</span>
      </IconButton>
    )

    expect(
      screen.getByRole('button', { name: 'Previous day' })
    ).toBeInTheDocument()
  })

  it('exposes the controlled selected state for icon toggles', () => {
    render(
      <IconToggleButton label="Ascending" isSelected>
        <span aria-hidden="true">↑</span>
      </IconToggleButton>
    )

    expect(screen.getByRole('button', { name: 'Ascending' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
