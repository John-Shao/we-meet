interface CalendarVisibilityEvent {
  id: string
  title: string
  display_calendar_id?: string | null
  details_redacted?: boolean
}

/**
 * Apply unified-calendar visibility only when that capability is enabled.
 *
 * The legacy event endpoint also returns ``display_calendar_id``.  When the
 * unified-calendar flag is off, the calendar list is deliberately not fetched,
 * so filtering against its empty id set would hide every upcoming event.
 */
export const prepareVisibleCalendarEvents = <
  Event extends CalendarVisibilityEvent,
>(
  events: Event[],
  options: {
    unifiedCalendarEnabled: boolean
    enabledCalendarIds: Set<string>
    busyTitle: string
  }
): Event[] => {
  const merged = new Map<string, Event>()
  for (const event of events) {
    if (
      options.unifiedCalendarEnabled &&
      event.display_calendar_id &&
      !options.enabledCalendarIds.has(event.display_calendar_id)
    ) {
      continue
    }
    const current = merged.get(event.id)
    if (!current || (current.details_redacted && !event.details_redacted)) {
      merged.set(event.id, {
        ...event,
        title: event.details_redacted ? options.busyTitle : event.title,
      })
    }
  }
  return [...merged.values()]
}
