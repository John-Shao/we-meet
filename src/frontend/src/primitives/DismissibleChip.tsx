import { forwardRef, type ReactNode } from 'react'
import {
  Button as RACButton,
  type ButtonProps as RACButtonProps,
} from 'react-aria-components'

import { cx } from '@/styled-system/css'

import { chipRecipe, type ChipRecipeProps } from './chipRecipe'

export type DismissibleChipProps = Omit<
  RACButtonProps,
  'aria-label' | 'children' | 'className'
> &
  Omit<NonNullable<ChipRecipeProps>, 'interactive'> & {
    /** Action-oriented accessible name, for example "Remove status: open". */
    label: string
    children: ReactNode
    className?: string
  }

/**
 * Compact removable selection or filter.
 *
 * The close glyph is deliberately owned by the primitive so product code
 * cannot drift in spacing, size, hover, pressed, focus, or disabled states.
 */
export const DismissibleChip = forwardRef<
  HTMLButtonElement,
  DismissibleChipProps
>(({ label, children, className, size, tone, ...props }, ref) => (
  <RACButton
    ref={ref}
    {...props}
    aria-label={label}
    className={cx(chipRecipe({ size, tone, interactive: true }), className)}
  >
    <span>{children}</span>
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  </RACButton>
))

DismissibleChip.displayName = 'DismissibleChip'
