import { useState } from 'react'

type Preferences = { showOriginal: boolean; sideBySide: boolean }

/** Reading preferences only; no transcript content is persisted. */
export function useTranslationViewPreferences(viewerId: string) {
  const key = `we-meet:translation-view:${viewerId}`
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
      return {
        showOriginal: saved?.showOriginal !== false,
        sideBySide: saved?.sideBySide === true,
      }
    } catch {
      return { showOriginal: true, sideBySide: false }
    }
  })
  const update = (change: Partial<Preferences>) => {
    const next = { ...preferences, ...change }
    setPreferences(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Reading remains available when browser storage is disabled.
    }
  }
  return [preferences, update] as const
}
