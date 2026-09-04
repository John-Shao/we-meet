import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react'

import { css, cva, cx } from '@/styled-system/css'

const menuItemSelector =
  '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])'

const ownedMenuItems = (surface: HTMLElement) =>
  Array.from(
    surface.querySelectorAll<HTMLButtonElement>(menuItemSelector)
  ).filter((item) => item.closest('[role="menu"]') === surface)

export interface ActionMenuSurfaceProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'role'
> {
  ariaLabel: string
  onClose?: () => void
  /** Focus the first enabled action when the menu opens. */
  autoFocus?: boolean
}

/**
 * Shared floating action-menu surface with roving keyboard focus.
 * Positioning remains caller-owned because anchored and context menus use
 * different coordinate systems.
 */
export const ActionMenuSurface = forwardRef<
  HTMLDivElement,
  ActionMenuSurfaceProps
>(
  (
    { ariaLabel, onClose, autoFocus = true, className, onKeyDown, ...props },
    forwardedRef
  ) => {
    const surfaceRef = useRef<HTMLDivElement>(null)
    useImperativeHandle(
      forwardedRef,
      () => surfaceRef.current as HTMLDivElement
    )

    useEffect(() => {
      const surface = surfaceRef.current
      if (autoFocus && surface) ownedMenuItems(surface)[0]?.focus()
    }, [autoFocus])

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return

      const surface = surfaceRef.current
      if (
        !surface ||
        (event.target as Element).closest('[role="menu"]') !== surface
      )
        return

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
        return
      }

      const items = ownedMenuItems(surface)
      if (items.length === 0) return
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      let next: number | undefined
      if (event.key === 'ArrowDown') next = (current + 1) % items.length
      if (event.key === 'ArrowUp')
        next = (current - 1 + items.length) % items.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = items.length - 1
      if (next === undefined) return

      event.preventDefault()
      items[next].focus()
    }

    return (
      <div
        {...props}
        ref={surfaceRef}
        role="menu"
        tabIndex={-1}
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className={cx(actionMenuSurfaceCss, className)}
      />
    )
  }
)

ActionMenuSurface.displayName = 'ActionMenuSurface'

const actionMenuItemRecipe = cva({
  base: {
    width: 'full',
    display: 'flex',
    alignItems: 'center',
    gap: 'sm',
    paddingX: 'md',
    paddingY: 'sm',
    border: 'none',
    borderRadius: 'field',
    backgroundColor: 'transparent',
    textAlign: 'left',
    textStyle: 'labelLarge',
    cursor: 'pointer',
    transition: 'color token(durations.fast), background token(durations.fast)',
    _hover: { backgroundColor: 'surface.canvas' },
    _active: { backgroundColor: 'action.selected.bg' },
    _focusVisible: {
      outline: '2px solid token(colors.border.focus)',
      outlineOffset: '-2px',
    },
    _disabled: {
      backgroundColor: 'transparent',
      color: 'text.disabled',
      cursor: 'default',
    },
  },
  variants: {
    tone: {
      neutral: { color: 'text.primary' },
      danger: {
        color: 'status.danger.container-text',
        _hover: { backgroundColor: 'status.danger.container' },
        _active: { backgroundColor: 'status.danger.container' },
      },
    },
    density: {
      compact: {
        paddingX: 'sm',
        paddingY: 'xs',
        textStyle: 'labelMedium',
      },
      default: {},
    },
  },
  defaultVariants: {
    tone: 'neutral',
    density: 'default',
  },
})

export type ActionMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'neutral' | 'danger'
  density?: 'compact' | 'default'
}

/** Standard action inside an ActionMenuSurface. */
export const ActionMenuItem = forwardRef<
  HTMLButtonElement,
  ActionMenuItemProps
>(({ tone, density, className, type = 'button', ...props }, ref) => (
  <button
    {...props}
    ref={ref}
    type={type}
    role={props.role ?? 'menuitem'}
    className={cx(actionMenuItemRecipe({ tone, density }), className)}
  />
))

ActionMenuItem.displayName = 'ActionMenuItem'

const actionMenuSurfaceCss = css({
  minWidth: '10rem',
  display: 'flex',
  flexDirection: 'column',
  padding: 'xs',
  border: '1px solid token(colors.border.default)',
  borderRadius: 'control',
  backgroundColor: 'surface.default',
  color: 'text.primary',
  boxShadow: 'overlay',
  outline: 'none',
})
