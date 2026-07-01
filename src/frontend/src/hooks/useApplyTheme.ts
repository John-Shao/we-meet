import { useEffect } from 'react'
import { useSnapshot } from 'valtio'
import { resolveTheme, themeStore } from '@/stores/theme'

/**
 * Applies the current theme preference to the document root as
 * `data-theme="light|dark"`, which panda's `_dark`/`_light` conditions key off.
 * When the preference is `system`, it tracks the OS setting live via matchMedia.
 */
export function useApplyTheme() {
  const { mode } = useSnapshot(themeStore)

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(mode)
    }
    apply()

    if (mode !== 'system' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [mode])
}
