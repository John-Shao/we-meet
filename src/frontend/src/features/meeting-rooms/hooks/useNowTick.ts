import { useEffect, useState } from 'react'

/**
 * A Date that refreshes once a minute — drives the timeline's "now" line.
 *
 * Disabled when the view is not showing today, so a calendar parked on next
 * week isn't re-rendering in the background forever.
 */
export const useNowTick = (enabled: boolean): Date => {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!enabled) return
    setNow(new Date())
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [enabled])

  return now
}
