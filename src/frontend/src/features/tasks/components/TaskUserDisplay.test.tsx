import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TaskUserDisplay } from './TaskUserDisplay'

describe('TaskUserDisplay', () => {
  it('renders the uploaded avatar beside the display name', () => {
    const { container } = render(
      <TaskUserDisplay
        user={{
          id: 'user-1',
          full_name: 'Ada Lovelace',
          short_name: null,
          avatar_url: '/ada.png',
        }}
      />
    )

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(container.querySelector('img[src="/ada.png"]')).toBeTruthy()
  })

  it('uses the calendar-style initial fallback when no avatar is uploaded', () => {
    render(
      <TaskUserDisplay
        user={{
          id: 'user-2',
          full_name: 'Grace Hopper',
          short_name: null,
          avatar_url: '',
        }}
      />
    )

    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    expect(
      screen.getByText('G', { selector: '[aria-hidden="true"]' })
    ).toBeInTheDocument()
  })
})
