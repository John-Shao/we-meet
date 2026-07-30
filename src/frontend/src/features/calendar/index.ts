export { CalendarRoute } from './routes/CalendarRoute'
export type { CalendarEvent, EventAttendee, RSVPStatus } from './api/ApiCalendar'

// P8:IM 会话日历抽屉/日程卡片的跨 feature 正规入口(im → calendar)。
export { CreateEventDialog } from './components/CreateEventDialog'
export { EventDetailHost } from './components/EventDetailHost'
export { MiniCalendar } from './components/MiniCalendar'
export { useCalendarSettings } from './hooks/useCalendarSettings'
export {
  fetchFreeBusy,
  fetchCalendarEvent,
  fetchCalendarEvents,
  type FreeBusyEntry,
  type BusyInterval,
} from './api/fetchCalendar'
export {
  busyPeopleInRange,
  isRangeFreeForAll,
  suggestCommonSlots,
  type PersonBusy,
  type SuggestedSlot,
} from './utils/freeSlots'
export {
  bucketReminderWindow,
  reminderCountdown,
  reminderTimeRange,
  type ReminderBuckets,
  type ReminderCountdown,
} from './utils/reminderWindow'
