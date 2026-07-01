import { proxy, subscribe } from 'valtio'
import { STORAGE_KEYS } from '@/utils/storageKeys'

/** User-selectable theme preference. `system` follows the OS setting live. */
export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_MODE_OPTIONS: ThemeMode[] = ['light', 'dark', 'system']

type ThemeState = {
  mode: ThemeMode
}

const DEFAULT_STATE: ThemeState = { mode: 'system' }

function getThemeState(): ThemeState {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (THEME_MODE_OPTIONS.includes(parsed?.mode)) {
        return { mode: parsed.mode }
      }
    }
  } catch {
    // ignore parse issues — fall back to default
  }
  return DEFAULT_STATE
}

export const themeStore = proxy<ThemeState>(getThemeState())

subscribe(themeStore, () => {
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, JSON.stringify(themeStore))
  } catch {
    // ignore persistence issues (private mode / quota)
  }
})

/** Resolve the effective theme (`system` → current OS preference). */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return mode
}
