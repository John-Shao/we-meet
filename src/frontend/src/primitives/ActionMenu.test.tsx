import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ActionMenuItem, ActionMenuSurface } from './ActionMenu'

describe('ActionMenu', () => {
  it('focuses enabled actions and supports keyboard navigation and Escape', async () => {
    const onClose = vi.fn()
    render(
      <ActionMenuSurface ariaLabel="Task actions" onClose={onClose}>
        <ActionMenuItem>Share</ActionMenuItem>
        <ActionMenuItem disabled>Unavailable</ActionMenuItem>
        <ActionMenuItem tone="danger">Delete</ActionMenuItem>
      </ActionMenuSurface>
    )

    const menu = screen.getByRole('menu', { name: 'Task actions' })
    const share = screen.getByRole('menuitem', { name: 'Share' })
    const remove = screen.getByRole('menuitem', { name: 'Delete' })
    await waitFor(() => expect(share).toHaveFocus())

    fireEvent.keyDown(share, { key: 'ArrowDown' })
    expect(remove).toHaveFocus()
    fireEvent.keyDown(remove, { key: 'Home' })
    expect(share).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
