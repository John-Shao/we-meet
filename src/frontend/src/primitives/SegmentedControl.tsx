import type { KeyboardEvent, ReactNode } from 'react'

import { css, cx } from '@/styled-system/css'

export interface SegmentedControlItem<T extends string> {
  id: T
  label: ReactNode
  testId?: string
  isDisabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  items: readonly SegmentedControlItem<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}

/**
 * Underlined page-level segmented control.
 *
 * Use this when choices switch between sibling page modes. It owns the tab
 * semantics and the complete interactive-state treatment; callers only
 * provide the current value and labels.
 */
export function SegmentedControl<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const focusAndSelect = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const enabledItems = items.filter((item) => !item.isDisabled)
    const currentEnabledIndex = enabledItems.findIndex(
      (item) => item.id === items[index].id
    )
    let nextIndex: number | undefined

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex =
          (currentEnabledIndex - 1 + enabledItems.length) % enabledItems.length
        break
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentEnabledIndex + 1) % enabledItems.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = enabledItems.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const nextItem = enabledItems[nextIndex]
    onChange(nextItem.id)
    const tabs =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
        '[role="tab"]:not([disabled])'
      )
    tabs?.[nextIndex]?.focus()
  }

  return (
    <div
      className={cx(segmentListCss, className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          disabled={item.isDisabled}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => focusAndSelect(event, index)}
          data-testid={item.testId}
          className={segmentCss}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

const segmentListCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'xs',
})

const segmentCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '5rem',
  paddingX: '0.75',
  paddingY: '0.375',
  border: 'none',
  borderBottom: '2px solid transparent',
  borderRadius: 'none',
  backgroundColor: 'transparent',
  color: 'text.secondary',
  textStyle: 'labelLarge',
  transition:
    'color token(durations.normal), border-color token(durations.normal), background token(durations.normal)',
  '&[aria-selected=true]': {
    borderBottomColor: 'border.focus',
    color: 'text.link',
  },
  cursor: 'pointer',
  _hover: {
    backgroundColor: 'surface.canvas',
    color: 'text.primary',
  },
  _active: {
    backgroundColor: 'action.selected.bg',
  },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '-2px',
  },
  _disabled: {
    color: 'text.disabled',
    cursor: 'default',
  },
})
