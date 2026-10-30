import { useEffect, useState } from 'react'

export const READ_ONLY_VIEWPORT_QUERY = '(max-width: 767px)'

/**
 * R0a mobile is read-only: below 768px the Composer and every mutating task
 * control are hidden. The server stays authoritative; this only decides which
 * affordances are rendered.
 */
export const useReadOnlyViewport = (): boolean => {
  const [readOnly, setReadOnly] = useState(false)

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
