import { useEffect } from 'react'
import { useSnapshot } from 'valtio'
import { resolveTheme, themeStore } from '@/stores/theme'

/**
 * Applies the current theme preference to the document root as
 * `data-theme="light|dark"`, which panda's `_dark`/`_light` conditions key off.
 * When the preference is `system`, it tracks the OS setting live via matchMedia.
 *
 * Also mirrors it into the CSS `color-scheme` property. That one is what the
 * browser reads when it paints the parts of the UI we do *not* control: the
 * popup list of a native `<select>`, scrollbars, date pickers. Without it a
 * dark-themed page draws near-white option text onto the UA's still-white
 * listbox, and the options are simply invisible.
 */
export function useApplyTheme() {
  const { mode } = useSnapshot(themeStore)

  useEffect(() => {
    const apply = () => {
      const theme = resolveTheme(mode)
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }
    apply()

    if (mode !== 'system' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [mode])
}
