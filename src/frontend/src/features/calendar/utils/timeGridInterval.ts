/**
 * Day/week time-grid interaction granularity.
 *
 * react-big-calendar uses `step` as the selectable and drag/resize snap unit,
 * while `timeslots` controls how many steps form one visible time group.
 * Four 15-minute slots therefore keep the existing hourly grid grouping.
 */
export const CALENDAR_TIME_GRID_INTERVAL = {
  step: 15,
  timeslots: 4,
} as const
