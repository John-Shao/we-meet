export interface CalendarCard {
  v: 1
  calendar_id: string
  name: string
  owner_name: string
  description: string
  subscriber_count: number
  subscribe_url: string
}

export const parseCalendarCard = (body: string): CalendarCard | null => {
  try {
    const value = JSON.parse(body) as Partial<CalendarCard>
    if (
      value.v !== 1 ||
      typeof value.calendar_id !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.subscribe_url !== 'string'
    )
      return null
    return {
      v: 1,
      calendar_id: value.calendar_id,
      name: value.name,
      owner_name: typeof value.owner_name === 'string' ? value.owner_name : '',
      description:
        typeof value.description === 'string' ? value.description : '',
      subscriber_count:
        typeof value.subscriber_count === 'number' ? value.subscriber_count : 0,
      subscribe_url: value.subscribe_url,
    }
  } catch {
    return null
  }
}
