import { cva } from '@/styled-system/css'

export type ChatCardSize = 'standard' | 'wide'

/**
 * Shared width tiers for cards rendered in the message stream.
 *
 * A card type selects a tier; its content may change the height but never the
 * width. `maxWidth` keeps every tier responsive inside the message column.
 */
export const chatCardSize = cva({
  base: {
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  variants: {
    size: {
      standard: { width: { base: '100%', md: '20rem' } },
      wide: { width: { base: '100%', md: '36rem' } },
    },
  },
  defaultVariants: {
    size: 'standard',
  },
})

/**
 * The card column fills the space left by the avatar on mobile. On desktop it
 * returns to content sizing, capped at the same 70% used by message bubbles.
 */
export const chatCardColumn = cva({
  base: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: { base: '1 1 0%', md: '0 1 auto' },
    maxWidth: { base: '100%', md: '70%' },
  },
  variants: {
    own: {
      true: { alignItems: 'flex-end' },
      false: { alignItems: 'flex-start' },
    },
  },
})
