import { useEffect, useState } from 'react'
import { useSnapshot } from 'valtio'
import { useTranslation } from 'react-i18next'
import { RiLayoutLeftLine, RiMoreLine, RiSearchLine, RiPhoneLine } from '@remixicon/react'
import { useUser } from '@/features/auth'
import { layoutStore } from '@/stores/layout'
import { openGlobalSearch } from './globalSearchBus'

/** Application chrome; window buttons remain owned by the operating system. */
export function DesktopTitleBar() {
  const shell = window.weMeetDesktop?.shell
  const { isLoggedIn } = useUser()
  const { showHeader, appRailCollapsed } = useSnapshot(layoutStore)
  const { t } = useTranslation('shell')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!shell) return
    let active = true
    const update = ({ fullscreen }: { fullscreen: boolean }) => {
      if (active)
        document.documentElement.toggleAttribute(
          'data-desktop-fullscreen',
          fullscreen
        )
    }
    const unsubscribe = shell.onWindowState(update)
    void shell
      .getWindowState()
      .then(update)
      .catch(() => {})
    const syncTheme = () => {
      const theme =
        document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
      void shell.setTheme(theme).catch(() => {})
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    syncTheme()
    return () => {
      active = false
      unsubscribe()
      observer.disconnect()
    }
  }, [shell])

  if (!shell) return null
  const workspace = isLoggedIn && showHeader
  return (
    <header
      className="desktop-titlebar"
      aria-label="We-Meet"
      data-testid="desktop-titlebar"
    >
      <div className="desktop-titlebar-actions">
        {workspace && (
          <>
            <button
              type="button"
              aria-label={t(appRailCollapsed ? 'railExpand' : 'railCollapse')}
              title={t(appRailCollapsed ? 'railExpand' : 'railCollapse')}
              aria-expanded={!appRailCollapsed}
              data-testid="rail-collapse-toggle"
              onClick={() =>
                window.dispatchEvent(new Event('we-meet:toggle-app-rail'))
              }
            >
              <RiLayoutLeftLine size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t('search.trigger')}
              title={`${t('search.trigger')} (Ctrl+K)`}
              onClick={() => openGlobalSearch()}
            >
              <RiSearchLine size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="AI 打电话"
              title="AI 打电话"
              onClick={() => {
                const bridge = window.weMeetDesktop?.aiCall
                if (bridge) void bridge.open().catch(() => {})
              }}
            >
              <RiPhoneLine size={18} aria-hidden="true" />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label={t('more')}
          title={t('more')}
          onClick={() => {
            setError('')
            void shell
              .openMenu()
              .catch(() => setError('菜单未能打开，请重试。'))
          }}
        >
          <RiMoreLine size={19} aria-hidden="true" />
        </button>
      </div>
      <span className="desktop-titlebar-name">We-Meet</span>
      {error && (
        <span role="status" className="desktop-titlebar-error">
          {error}
        </span>
      )}
    </header>
  )
}
