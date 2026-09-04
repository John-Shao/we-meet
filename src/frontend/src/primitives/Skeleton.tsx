import type { CSSProperties, ReactNode } from 'react'

import { srOnly } from '@/styles/a11y'
import { css, cva, cx } from '@/styled-system/css'

const skeletonRecipe = cva({
  base: {
    display: 'block',
    flexShrink: 0,
    backgroundColor: 'border.subtle',
    animation: 'skeleton-pulse 900ms ease-in-out infinite alternate',
  },
  variants: {
    shape: {
      text: { borderRadius: 'field' },
      rectangle: { borderRadius: 'control' },
      circle: { borderRadius: 'pill' },
    },
  },
  defaultVariants: {
    shape: 'text',
  },
})

const skeletonContent = css({ display: 'contents' })

export type SkeletonShape = 'text' | 'rectangle' | 'circle'

export interface SkeletonProps {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  shape?: SkeletonShape
  className?: string
}

export const Skeleton = ({
  width = '100%',
  height = '0.75rem',
  shape = 'text',
  className,
}: SkeletonProps) => (
  <span
    aria-hidden="true"
    className={cx(skeletonRecipe({ shape }), className)}
    data-shape={shape}
    style={{ width, height }}
  />
)

export interface SkeletonRegionProps {
  label: string
  children: ReactNode
  className?: string
}

export const SkeletonRegion = ({
  label,
  children,
  className,
}: SkeletonRegionProps) => (
  <div
    className={className}
    role="status"
    aria-label={label}
    aria-live="polite"
    aria-busy="true"
  >
    <span className={srOnly}>{label}</span>
    <div className={skeletonContent} aria-hidden="true">
      {children}
    </div>
  </div>
)
