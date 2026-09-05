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
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  variants: {
    size: {
      standard: { width: '20rem' },
      wide: { width: '36rem' },
    },
  },
  defaultVariants: {
    size: 'standard',
  },
})
