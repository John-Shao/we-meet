import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  InteractiveList,
  InteractiveListRow,
  SelectableListRow,
} from './InteractiveListRow'

describe('InteractiveListRow', () => {
  it('exposes toggle selection and remains actionable', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <SelectableListRow isSelected onClick={onClick}>
        Member
      </SelectableListRow>
    )

    const row = screen.getByRole('button', { name: 'Member' })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('data-selected', 'true')
    await user.click(row)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('uses listbox selection semantics for option rows', () => {
    render(
      <InteractiveListRow role="option" isSelected={false}>
        Open
      </InteractiveListRow>
    )

    const row = screen.getByRole('option', { name: 'Open' })
    expect(row).toHaveAttribute('aria-selected', 'false')
    expect(row).not.toHaveAttribute('aria-pressed')
  })

  it('forwards the native disabled state', () => {
    render(
      <SelectableListRow isSelected disabled>
        Existing member
      </SelectableListRow>
    )

    expect(
      screen.getByRole('button', { name: 'Existing member' })
    ).toBeDisabled()
  })

  it('moves focus through enabled rows with list navigation keys', async () => {
    const user = userEvent.setup()
    render(
      <InteractiveList ariaLabel="People" selectionMode="single">
        <InteractiveListRow role="option" isSelected>
          First
        </InteractiveListRow>
        <InteractiveListRow role="option" isSelected={false} disabled>
          Disabled
        </InteractiveListRow>
        <InteractiveListRow role="option" isSelected={false}>
          Last
        </InteractiveListRow>
      </InteractiveList>
    )

    const first = screen.getByRole('option', { name: 'First' })
    const last = screen.getByRole('option', { name: 'Last' })
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(last).toHaveFocus()
    await user.keyboard('{Home}')
    expect(first).toHaveFocus()
    expect(screen.getByRole('listbox', { name: 'People' })).toBeInTheDocument()
  })
})
