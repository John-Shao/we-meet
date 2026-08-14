import { render } from '@testing-library/react'
import { Calendar, dateFnsLocalizer } from 'react-big-calendar'
import { format, getDay, parse, startOfWeek } from 'date-fns'
import { enUS } from 'date-fns/locale'
import { describe, expect, it } from 'vitest'

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { 'en-US': enUS },
})

describe('web calendar week view', () => {
  it('renders the full seven-day week including both weekend days', () => {
    const friday = new Date(2026, 7, 14)
    const { container } = render(
      <Calendar
        culture="en-US"
        date={friday}
        events={[]}
        getNow={() => friday}
        localizer={localizer}
        max={new Date(2026, 7, 14, 23, 59)}
        min={new Date(2026, 7, 14, 0, 0)}
        onNavigate={() => {}}
        onView={() => {}}
        scrollToTime={new Date(2026, 7, 14, 8, 0)}
        style={{ height: 640, width: 960 }}
        view="week"
        views={{ week: true }}
      />
    )

    expect(
      container.querySelectorAll('.rbc-time-header-content .rbc-header')
    ).toHaveLength(7)
    expect(
      container.querySelectorAll('.rbc-time-content > .rbc-day-slot')
    ).toHaveLength(7)
  })
})
