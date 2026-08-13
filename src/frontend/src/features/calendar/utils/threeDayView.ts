import { addDays, startOfDay } from 'date-fns'
import { Navigate, type NavigateAction } from 'react-big-calendar'

export const THREE_DAY_COUNT = 3

/** A rolling three-day range. Weekends are ordinary days and are never skipped. */
export const threeDayRange = (date: Date): Date[] => {
  const first = startOfDay(date)
  return Array.from({ length: THREE_DAY_COUNT }, (_, index) =>
    addDays(first, index)
  )
}

export const navigateThreeDay = (
  date: Date,
  action: NavigateAction
): Date => {
  if (action === Navigate.PREVIOUS) return addDays(date, -THREE_DAY_COUNT)
  if (action === Navigate.NEXT) return addDays(date, THREE_DAY_COUNT)
  return date
}
