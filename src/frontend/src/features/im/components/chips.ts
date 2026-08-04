import { css } from '@/styled-system/css'

/**
 * Inline chips used next to a name — group owner, departed member, bot.
 *
 * Extracted when the bot badge became the third copy of the same six
 * declarations. They are class constants rather than a component because every
 * use site already sits inside a flex row and only differs by its label.
 */

/** Emphasis chip (群主). */
export const brandChipCls = css({
  flexShrink: 0,
  fontSize: '0.6875rem',
  borderRadius: '0.25rem',
  paddingX: '0.25rem',
  color: 'brand.600',
  backgroundColor: 'brand.50',
  border: '1px solid token(colors.brand.200)',
})

/**
 * Neutral chip (已离职, 机器人).
 *
 * Deliberately greyscale rather than error/warning: neither "this person left"
 * nor "this is a bot" is an error state. `error.*` is also an inverted scale
 * (100 is the darkest), so copying the brand chip with `error.50` yields an
 * invalid token and a silently dropped background.
 */
export const neutralChipCls = css({
  flexShrink: 0,
  fontSize: '0.6875rem',
  borderRadius: '0.25rem',
  paddingX: '0.25rem',
  color: 'greyscale.600',
  backgroundColor: 'greyscale.100',
  border: '1px solid token(colors.greyscale.300)',
})
