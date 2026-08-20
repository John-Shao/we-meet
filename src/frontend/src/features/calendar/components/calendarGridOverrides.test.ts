import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

describe('calendar grid focus styles', () => {
  it('keeps the event focus ring inside edge-day cells', () => {
    const stylesheet = fs.readFileSync(
      path.resolve(__dirname, './calendarGridOverrides.css'),
      'utf8'
    )
    const focusRule = stylesheet.match(/\.rbc-event:focus\s*\{([^}]*)\}/)?.[1]

    expect(focusRule).toContain('outline: 2px solid var(--colors-focus-ring)')
    expect(focusRule).toContain('outline-offset: -2px')
  })
})
