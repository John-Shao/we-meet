import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from '@/primitives'

import { PageState } from './PageState'

describe('PageState', () => {
  it('renders a polite empty state with an optional action', () => {
    render(
      <PageState
        icon={<span>icon</span>}
        title="Nothing here"
        description="Create the first item."
        action={<Button>Create</Button>}
      />
    )

    const state = screen.getByRole('status')
    expect(state).toHaveAttribute('data-state', 'empty')
    expect(state).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('renders an assertive error card', () => {
    render(
      <PageState
        state="error"
        surface="card"
        density="compact"
        title="Unable to load"
      />
    )

    const state = screen.getByRole('alert')
    expect(state).toHaveAttribute('data-surface', 'card')
    expect(state).toHaveAttribute('data-density', 'compact')
    expect(state).toHaveAttribute('aria-live', 'assertive')
  })
})
