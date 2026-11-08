import { useEffect, useState } from 'react'

export const READ_ONLY_VIEWPORT_QUERY = '(max-width: 767px)'

// Evaluated lazily by useState, so the very first render already knows the
// viewport instead of starting from `false` and correcting itself in an effect.
const isReadOnlyViewport = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(READ_ONLY_VIEWPORT_QUERY).matches

/**
 * R0a mobile is read-only: below 768px the Composer and every mutating task
 * control are hidden. The server stays authoritative; this only decides which
 * affordances are rendered.
 */
export const useReadOnlyViewport = (): boolean => {
  // Read the media query during the first render rather than in an effect: on a
  // phone the effect-only version painted one frame of the desktop affordances
  // (composer, mutating buttons) before flipping to read-only. Lazy initialisation
  // keeps that first paint already correct; the effect then only follows changes.
  const [readOnly, setReadOnly] = useState(isReadOnlyViewport)

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return
    }
    const mediaQuery = window.matchMedia(READ_ONLY_VIEWPORT_QUERY)
    setReadOnly(mediaQuery.matches)
    const onChange = (event: MediaQueryListEvent) => {
      setReadOnly(event.matches)
    }
    mediaQuery.addEventListener('change', onChange)
    return () => mediaQuery.removeEventListener('change', onChange)
  }, [])

  return readOnly
}
