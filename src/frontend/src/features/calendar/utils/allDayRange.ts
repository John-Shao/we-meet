/** Convert an API-exclusive all-day end into the form's inclusive end day. */
export const inclusiveAllDayEnd = (start: Date, exclusiveEnd: Date): Date => {
  const end = new Date(exclusiveEnd)
  end.setDate(end.getDate() - 1)
  return end < start ? new Date(start) : end
}

/** Convert inclusive all-day form values to the API's half-open date range. */
export const allDayApiRange = (
  startValue: string,
  endValue: string
): { start: Date; end: Date } => {
  const start = new Date(`${startValue.slice(0, 10)}T00:00`)
  const end = new Date(`${endValue.slice(0, 10)}T00:00`)
  end.setDate(end.getDate() + 1)
  return { start, end }
}
