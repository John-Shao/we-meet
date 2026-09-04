import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Skeleton, SkeletonRegion } from './Skeleton'

describe('Skeleton', () => {
  it('renders a decorative semantic block', () => {
    const { container } = render(
      <Skeleton width="2rem" height="2rem" shape="circle" />
    )

    const block = container.querySelector('[data-shape="circle"]')
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(block).toHaveStyle({ width: '2rem', height: '2rem' })
  })

  it('announces a busy loading region without exposing placeholder content', () => {
    render(
      <SkeletonRegion label="Loading contacts">
        <Skeleton />
      </SkeletonRegion>
    )

    const region = screen.getByRole('status', { name: 'Loading contacts' })
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })
})
