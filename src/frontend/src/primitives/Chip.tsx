import { cx } from '@/styled-system/css'
import { chipRecipe, type ChipRecipeProps } from './chipRecipe'

/**
 * Compact label primitive for filters, selections, people, and inline metadata.
 *
 * Chip owns shape and semantic color pairing. Product code supplies only the
 * label and intent; it must not recreate palette-based chip styles locally.
 */
export type ChipProps = React.HTMLAttributes<HTMLSpanElement> &
  Omit<NonNullable<ChipRecipeProps>, 'interactive'>

export const Chip = ({ className, size, tone, ...props }: ChipProps) => (
  <span {...props} className={cx(chipRecipe({ size, tone }), className)} />
)
