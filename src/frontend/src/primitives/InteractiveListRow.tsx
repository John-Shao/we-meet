import { RiCheckLine } from '@remixicon/react'
import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { cva, cx } from '@/styled-system/css'

const interactiveListRowRecipe = cva({
  base: {
    display: 'flex',
    alignItems: 'center',
    gap: 'md',
    width: 'full',
    border: 'none',
    backgroundColor: 'transparent',
    color: 'text.primary',
    textAlign: 'left',
    cursor: 'pointer',
    transition:
      'background-color token(durations.fast), color token(durations.fast)',
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
    density: {
      compact: {
        minHeight: 'controlHeight.compact',
        paddingX: 'sm',
        paddingY: 'xs',
        borderRadius: 'field',
        textStyle: 'bodyMedium',
      },
      default: {
        minHeight: 'controlHeight.large',
        paddingX: 'lg',
        paddingY: 'sm',
        borderRadius: 'none',
        textStyle: 'bodyLarge',
      },
    },
    divider: {
      true: {
        borderBottom: '1px solid token(colors.border.subtle)',
      },
    },
    selected: {
      true: {
        backgroundColor: 'action.selected.bg',
        color: 'action.selected.text',
        _hover: { backgroundColor: 'action.selected.bg' },
      },
    },
    rounded: {
      true: { borderRadius: 'control' },
    },
  },
  defaultVariants: {
    density: 'default',
    divider: false,
    selected: false,
    rounded: false,
  },
})

export type InteractiveListRowProps =
  ButtonHTMLAttributes<HTMLButtonElement> & {
    /** Applies the shared selected treatment and selection ARIA state. */
    isSelected?: boolean
    density?: 'compact' | 'default'
    divider?: boolean
    rounded?: boolean
  }

/**
 * Shared row action for search results, pickers, and compact choice panels.
 *
 * The caller owns the surrounding list semantics. When `role="option"` is
 * supplied, selection is exposed with `aria-selected`; otherwise a selected
 * row is treated as a toggle button through `aria-pressed`.
 */
export const InteractiveListRow = forwardRef<
  HTMLButtonElement,
  InteractiveListRowProps
>(
  (
    {
      isSelected,
      density,
      divider,
      rounded,
      className,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const selectionAttributes =
      isSelected === undefined
        ? {}
        : props.role === 'option'
          ? { 'aria-selected': props['aria-selected'] ?? isSelected }
          : { 'aria-pressed': props['aria-pressed'] ?? isSelected }

    return (
      <button
        {...props}
        {...selectionAttributes}
        ref={ref}
        type={type}
        data-selected={isSelected || undefined}
        data-interactive-list-row="true"
        className={cx(
          interactiveListRowRecipe({
            density,
            divider,
            selected: isSelected,
            rounded,
          }),
          className
        )}
      />
    )
  }
)

InteractiveListRow.displayName = 'InteractiveListRow'

export interface InteractiveListProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'role'
> {
  ariaLabel?: string
  selectionMode?: 'single' | 'multiple'
}

/**
 * Keyboard navigation boundary for a group of InteractiveListRows.
 * Selection semantics are opt-in so search-result groups can remain ordinary
 * actions while picker choices become a listbox.
 */
export const InteractiveList = ({
  ariaLabel,
  selectionMode,
  className,
  onKeyDown,
  ...props
}: InteractiveListProps) => {
  const listRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    const list = listRef.current
    if (!list) return
    const rows = Array.from(
      list.querySelectorAll<HTMLButtonElement>(
        '[data-interactive-list-row]:not([disabled])'
      )
    ).filter((row) => row.closest('[data-interactive-list]') === list)
    if (rows.length === 0) return

    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | undefined
    if (event.key === 'ArrowDown') next = Math.min(current + 1, rows.length - 1)
    if (event.key === 'ArrowUp')
      next = current < 0 ? rows.length - 1 : Math.max(current - 1, 0)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = rows.length - 1
    if (next === undefined) return

    event.preventDefault()
    rows[next]?.focus()
  }

  return (
    <div
      {...props}
      ref={listRef}
      role={selectionMode ? 'listbox' : ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      aria-multiselectable={selectionMode === 'multiple' || undefined}
      data-interactive-list="true"
      onKeyDown={handleKeyDown}
      className={className}
    />
  )
}

export type SelectableListRowProps = Omit<
  InteractiveListRowProps,
  'isSelected' | 'children'
> & {
  isSelected: boolean
  children: ReactNode
}

/** Multi-select row with a fixed-size semantic check indicator. */
export const SelectableListRow = forwardRef<
  HTMLButtonElement,
  SelectableListRowProps
>(({ isSelected, disabled, children, ...props }, ref) => (
  <InteractiveListRow
    {...props}
    ref={ref}
    isSelected={isSelected}
    disabled={disabled}
  >
    <span
      aria-hidden="true"
      data-selected={isSelected || undefined}
      data-disabled={disabled || undefined}
      className={selectionIndicatorCss}
    >
      <RiCheckLine size={14} />
    </span>
    {children}
  </InteractiveListRow>
))

SelectableListRow.displayName = 'SelectableListRow'

const selectionIndicatorCss = cva({
  base: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 'selectionControl.compact',
    height: 'selectionControl.compact',
    border: '1px solid token(colors.border.strong)',
    borderRadius: 'extraSmall',
    backgroundColor: 'surface.default',
    color: 'transparent',
    transition:
      'background-color token(durations.fast), border-color token(durations.fast), color token(durations.fast)',
    '&[data-selected]': {
      borderColor: 'action.primary.bg',
      backgroundColor: 'action.primary.bg',
      color: 'action.primary.text',
    },
    '&[data-disabled]': {
      borderColor: 'border.subtle',
      backgroundColor: 'surface.canvas',
      color: 'text.disabled',
    },
  },
})()
