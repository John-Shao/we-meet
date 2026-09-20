/** Calendar dates use the viewer's local midnight, including DST transitions. */
export function recordDateRange(from: string, through: string) {
  const parse = (value: string, followingDay = false) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date')
    const [year, month, day] = value.split('-').map(Number)
    if (year < 1000 || year > 9998) throw new Error('Invalid date')
    const date = new Date(year, month - 1, day)
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    )
      throw new Error('Invalid date')
    if (followingDay) date.setDate(date.getDate() + 1)
    return date.toISOString()
  }
  const created_from = from ? parse(from) : undefined
  const created_before = through ? parse(through, true) : undefined
  if (from && through && from > through) throw new Error('Invalid range')
  return { created_from, created_before }
}
