import { describe, expect, it } from 'vitest'

import { prepareVisibleCalendarEvents } from './visibleCalendarEvents'

const events = [
  {
    id: 'event-1',
    title: '下午会',
    display_calendar_id: 'primary-1',
    details_redacted: false,
  },
]

describe('prepareVisibleCalendarEvents', () => {
  it('keeps legacy events when unified calendars are disabled', () => {
    expect(
      prepareVisibleCalendarEvents(events, {
        unifiedCalendarEnabled: false,
        enabledCalendarIds: new Set(),
        busyTitle: '忙碌',
      })
    ).toEqual(events)
  })

  it('filters disabled calendars when unified calendars are enabled', () => {
    expect(
      prepareVisibleCalendarEvents(events, {
        unifiedCalendarEnabled: true,
        enabledCalendarIds: new Set(),
        busyTitle: '忙碌',
      })
    ).toEqual([])
  })

  it('deduplicates projections and prefers visible event details', () => {
    expect(
      prepareVisibleCalendarEvents(
        [
          {
            ...events[0],
            title: '隐藏标题',
            details_redacted: true,
          },
          events[0],
        ],
        {
          unifiedCalendarEnabled: true,
          enabledCalendarIds: new Set(['primary-1']),
          busyTitle: '忙碌',
        }
      )
    ).toEqual(events)
  })
})
