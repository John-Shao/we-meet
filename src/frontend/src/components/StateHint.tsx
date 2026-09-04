import type { ReactNode } from 'react'
import { RiErrorWarningLine } from '@remixicon/react'

import { css, cva, cx } from '@/styled-system/css'

/**
 * Compact loading / empty / error feedback for lists, panels and dialogs.
 * Uses semantic colors, live-region roles and one standard retry/action slot.
 */
const stateHintRecipe = cva({
  base: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'sm',
    padding: 'xl',
    textStyle: 'bodyMedium',
    textAlign: 'center',
  },
  variants: {
    state: {
      loading: { color: 'text.secondary' },
      empty: { color: 'text.secondary' },
      error: { color: 'status.danger' },
    },
  },
  defaultVariants: {
    state: 'empty',
  },
})

const message = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'sm',
})

const spinner = css({
  flexShrink: 0,
  width: '1rem',
  height: '1rem',
  borderRadius: 'pill',
  border: '2px solid',
  borderColor: 'border.default',
  borderTopColor: 'icon.secondary',
  animation: 'rotate 700ms linear infinite',
})

export type StateHintState = 'loading' | 'empty' | 'error'

export interface StateHintProps {
  children: ReactNode
  state?: StateHintState
  action?: ReactNode
  className?: string
}

export const StateHint = ({
  children,
  state = 'empty',
  action,
  className,
}: StateHintProps) => {
  const isError = state === 'error'

  return (
    <div
      className={cx(stateHintRecipe({ state }), className)}
      data-state={state}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-busy={state === 'loading' || undefined}
    >
      <span className={message}>
        {state === 'loading' ? (
          <span className={spinner} aria-hidden="true" />
        ) : null}
        {isError ? <RiErrorWarningLine size={18} aria-hidden="true" /> : null}
        <span>{children}</span>
      </span>
      {action}
    </div>
  )
}
