import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from 'react-aria-components'
import type { Participant } from 'livekit-client'
import {
  ControllerContext,
  type RequestAvailability,
} from './ControllerContext'
import { RemoteControlMenuItem } from '@/features/rooms/livekit/components/ParticipantMenu/RemoteControlMenuItem'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function fixture(availability: RequestAvailability) {
  const request = vi.fn()
  render(
    <ControllerContext.Provider
      value={{
        canRequest: () => availability === 'available',
        requestAvailability: () => availability,
        request,
      }}
    >
      <Menu aria-label="participant">
        <RemoteControlMenuItem participant={{ identity: 'B' } as Participant} />
      </Menu>
    </ControllerContext.Provider>
  )
  return request
}

describe('remote request menu availability', () => {
  it.each(['desktopRequired', 'versionMismatch', 'busy'] as const)(
    'disables the action and explains %s',
    (availability) => {
      const request = fixture(availability)
      const item = screen.getByRole('menuitem')
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(
        screen.getByText(`unavailable.${availability}`)
      ).toBeInTheDocument()
      fireEvent.click(item)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('hides the entry when the feature or local context is unavailable', () => {
    fixture('hidden')
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
  it('keeps an eligible request actionable', () => {
    const request = fixture('available')
    fireEvent.click(screen.getByRole('menuitem'))
    expect(request).toHaveBeenCalledOnce()
  })
})
