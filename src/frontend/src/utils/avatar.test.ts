import { describe, expect, it } from 'vitest'

import { AVATAR_FALLBACK_COLORS, avatarFallbackColor } from './avatar'

const relativeLuminance = (hex: string): number => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

describe('avatarFallbackColor', () => {
  it('keeps every white-initial pairing at WCAG AA contrast', () => {
    AVATAR_FALLBACK_COLORS.forEach((background) => {
      const contrast = 1.05 / (relativeLuminance(background) + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
    })
  })

  it('is deterministic for a display name', () => {
    expect(avatarFallbackColor('W009')).toBe('#2563eb')
  })
})
