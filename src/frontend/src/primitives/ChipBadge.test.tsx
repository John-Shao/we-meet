import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Badge } from './Badge'
import { Chip } from './Chip'
import { DismissibleChip } from './DismissibleChip'

describe('semantic label primitives', () => {
  it('applies distinct Chip tones and preserves caller classes', () => {
    render(
      <>
        <Chip className="consumer-chip" data-testid="neutral-chip">
          Neutral
        </Chip>
        <Chip data-testid="danger-chip" tone="danger">
          Danger
        </Chip>
      </>
    )

    const neutral = screen.getByTestId('neutral-chip')
    const danger = screen.getByTestId('danger-chip')
    expect(neutral).toHaveClass('consumer-chip')
    expect(neutral.className).not.toBe(danger.className)
  })

  it('supports status Badge tones and preserves caller classes', () => {
    render(
      <Badge
        className="consumer-badge"
        data-testid="warning-badge"
        tone="warning"
      >
        Warning
      </Badge>
    )

    expect(screen.getByTestId('warning-badge')).toHaveClass('consumer-badge')
  })

  it('gives a dismissible Chip one action name and one shared close glyph', () => {
    const onPress = vi.fn()
    render(
      <DismissibleChip
        label="Remove priority: high"
        tone="brand"
        onPress={onPress}
      >
        Priority: high
      </DismissibleChip>
    )

    const chip = screen.getByRole('button', { name: 'Remove priority: high' })
    expect(chip.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(chip)
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
