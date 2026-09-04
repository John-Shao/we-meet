import type { ReactNode } from 'react'

import { cva, cx } from '@/styled-system/css'

const pageStateRecipe = cva({
  base: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'sm',
    textAlign: 'center',
  },
  variants: {
    density: {
      compact: {
        minHeight: '8rem',
        paddingX: 'lg',
        paddingY: 'xl',
      },
      default: {
        minHeight: '18rem',
        padding: '2xl',
      },
    },
    surface: {
      plain: {},
      card: {
        border: '1px solid token(colors.border.subtle)',
        borderRadius: 'card',
        backgroundColor: 'surface.default',
      },
    },
  },
  defaultVariants: {
    density: 'default',
    surface: 'plain',
  },
})

const pageStateIconRecipe = cva({
  base: {
    width: '3rem',
    height: '3rem',
    display: 'grid',
    flexShrink: 0,
    placeItems: 'center',
    borderRadius: 'pill',
  },
  variants: {
    state: {
      empty: {
        backgroundColor: 'surface.canvas',
        color: 'icon.secondary',
      },
      error: {
        backgroundColor: 'status.danger.container',
        color: 'status.danger.container-text',
      },
    },
  },
  defaultVariants: {
    state: 'empty',
  },
})

const titleRecipe = cva({
  base: {
    maxWidth: '32rem',
    margin: 0,
    color: 'text.primary',
    textStyle: 'titleMedium',
  },
  variants: {
    hasIcon: {
      true: { marginTop: 'xs' },
      false: {},
    },
  },
})

const descriptionRecipe = cva({
  base: {
    maxWidth: '32rem',
    margin: 0,
    color: 'text.secondary',
    textStyle: 'bodyMedium',
  },
  variants: {
    state: {
      empty: {},
      error: { color: 'status.danger.container-text' },
    },
  },
  defaultVariants: {
    state: 'empty',
  },
})

const actionRecipe = cva({
  base: { marginTop: 'sm' },
})

export type PageStateKind = 'empty' | 'error'

export interface PageStateProps {
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  state?: PageStateKind
  density?: 'compact' | 'default'
  surface?: 'plain' | 'card'
  className?: string
}

export const PageState = ({
  icon,
  title,
  description,
  action,
  state = 'empty',
  density = 'default',
  surface = 'plain',
  className,
}: PageStateProps) => {
  const isError = state === 'error'

  return (
    <div
      className={cx(pageStateRecipe({ density, surface }), className)}
      data-density={density}
      data-state={state}
      data-surface={surface}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      {icon ? (
        <span className={pageStateIconRecipe({ state })} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {title ? (
        <h2 className={titleRecipe({ hasIcon: !!icon })}>{title}</h2>
      ) : null}
      {description ? (
        <p className={descriptionRecipe({ state })}>{description}</p>
      ) : null}
      {action ? <div className={actionRecipe()}>{action}</div> : null}
    </div>
  )
}
