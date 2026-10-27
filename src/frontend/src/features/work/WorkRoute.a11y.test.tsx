import { render } from '@testing-library/react'
import axe from 'axe-core'
import { expect, it } from 'vitest'
import { WorkRoute } from './WorkRoute'

it('has no detectable accessibility violations', async () => {
  const { container } = render(<WorkRoute />)
  const results = await axe.run(container, {
    rules: {
      // jsdom has no layout engine; contrast is validated in Playwright later.
      'color-contrast': { enabled: false },
    },
  })
  expect(results.violations).toEqual([])
})
