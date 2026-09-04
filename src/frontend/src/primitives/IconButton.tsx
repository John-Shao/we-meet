import { forwardRef, type ReactNode } from 'react'

import { Button, type ButtonProps } from './Button'
import { ToggleButton, type ToggleButtonProps } from './ToggleButton'

export type IconButtonSize = 'icon24' | 'icon28' | 'icon32'

type SharedIconButtonProps = {
  /** Accessible name. It is also used as the default tooltip. */
  label: string
  children: ReactNode
  size?: IconButtonSize
  tooltip?: string
}

export type IconButtonProps = Omit<
  ButtonProps,
  'aria-label' | 'children' | 'size' | 'tooltip'
> &
  SharedIconButtonProps

/**
 * Standard icon-only action.
 *
 * Requiring `label` prevents unlabeled icon buttons, while the fixed size set
 * keeps product code on the shared component contract.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tooltip = label,
      size = 'icon28',
      variant = 'quaternaryText',
      children,
      ...props
    },
    ref
  ) => (
    <Button
      ref={ref}
      {...props}
      aria-label={label}
      tooltip={tooltip}
      size={size}
      variant={variant}
    >
      {children}
    </Button>
  )
)

IconButton.displayName = 'IconButton'

export type IconToggleButtonProps = Omit<
  ToggleButtonProps,
  'aria-label' | 'children' | 'size' | 'tooltip'
> &
  SharedIconButtonProps

/** Standard icon-only toggle with the same accessibility and size contract. */
export const IconToggleButton = forwardRef<
  HTMLButtonElement,
  IconToggleButtonProps
>(
  (
    {
      label,
      tooltip = label,
      size = 'icon28',
      variant = 'quaternaryText',
      children,
      ...props
    },
    ref
  ) => (
    <ToggleButton
      ref={ref}
      {...props}
      aria-label={label}
      tooltip={tooltip}
      size={size}
      variant={variant}
    >
      {children}
    </ToggleButton>
  )
)

IconToggleButton.displayName = 'IconToggleButton'
