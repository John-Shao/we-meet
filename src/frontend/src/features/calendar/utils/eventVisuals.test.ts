import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CALENDAR_COLOR,
  calendarColorForEvent,
  calendarColorStyle,
  normalizeCalendarColor,
} from './eventVisuals'

describe('calendar event visuals', () => {
  it('uses the display calendar color as the ownership hue', () => {
    expect(
      calendarColorForEvent(
        { display_calendar_id: 'shared-alice' },
        { 'shared-alice': '#e11d48' }
      )
    ).toBe('#E11D48')
  })

  it('falls back safely for legacy events and invalid subscription colors', () => {
    expect(calendarColorForEvent({ display_calendar_id: null }, {})).toBe(
      DEFAULT_CALENDAR_COLOR
    )
    expect(
      calendarColorForEvent(
        { display_calendar_id: 'shared-alice' },
        { 'shared-alice': 'not-a-color' }
      )
    ).toBe(DEFAULT_CALENDAR_COLOR)
  })

  it('only emits normalized colors into the CSS custom property', () => {
    expect(normalizeCalendarColor('#12abEF')).toBe('#12ABEF')
    expect(calendarColorStyle('#12abEF')).toEqual({
      '--wm-calendar-color': '#12ABEF',
    })
  })
})
