import { useEffect, useState } from 'react'
import { useSnapshot } from 'valtio'
import { useTranslation } from 'react-i18next'
import {
  RiLayoutLeftLine,
  RiMoreLine,
  RiPushpinFill,
  RiPushpinLine,
  RiRobot2Line,
  RiSearchLine,
  RiPhoneLine,
} from '@remixicon/react'
import { useUser } from '@/features/auth'
import { layoutStore } from '@/stores/layout'
import { openGlobalSearch } from './globalSearchBus'

/** Application chrome; window buttons remain owned by the operating system. */
export function DesktopTitleBar({
  variant = 'default',
}: {
  variant?: 'default' | 'plain'
} = {}) {
  const shell = window.weMeetDesktop?.shell
  const { isLoggedIn } = useUser()
  const { showHeader, appRailCollapsed } = useSnapshot(layoutStore)
  const { t } = useTranslation('shell')
  const [error, setError] = useState('')
  const [aiCall, setAiCall] = useState<{
    state: 'idle' | 'connecting' | 'active' | 'sharing' | 'error' | 'ended'
    startedAt?: number
    sharing?: boolean
  } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const bridge = window.weMeetDesktop?.aiCall
    if (!bridge) return
    const unsubscribe = bridge.onStatus(setAiCall)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!aiCall || (aiCall.state !== 'active' && aiCall.state !== 'sharing'))
      return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [aiCall?.state, aiCall?.startedAt])

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
  if (variant === 'plain') return <CallTitleBar />
  const workspace = isLoggedIn && showHeader
  const callActive = aiCall?.state === 'active' || aiCall?.state === 'sharing'
  const callSeconds = aiCall?.startedAt
    ? Math.max(0, Math.floor((now - aiCall.startedAt) / 1000))
    : 0
  const callTime = `${String(Math.floor(callSeconds / 60)).padStart(2, '0')}:${String(callSeconds % 60).padStart(2, '0')}`
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
              aria-label="AI 助手"
              title="AI 助手"
              onClick={() => {
                window.location.assign('/assistant')
              }}
            >
              <RiRobot2Line size={18} aria-hidden="true" />
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
      {callActive && (
        <button
          type="button"
          aria-label="打开 AI 通话"
          title="打开 AI 通话"
          onClick={() => {
            const bridge = window.weMeetDesktop?.aiCall
            if (bridge) void bridge.open().catch(() => {})
          }}
          style={{
            border: 0,
            borderRadius: 999,
            padding: '4px 10px',
            background: '#e8f5e9',
            color: '#1b5e20',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          AI 通话中 {callTime}
        </button>
      )}
      <span className="desktop-titlebar-name">We-Meet</span>
      {error && (
        <span role="status" className="desktop-titlebar-error">
          {error}
        </span>
      )}
    </header>
  )
}

function CallTitleBar() {
  const bridge = window.weMeetDesktop?.aiCall
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    let active = true
    void bridge
      ?.getPinned?.()
      .then((value) => {
        if (active && typeof value === 'boolean') setPinned(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [bridge])

  const togglePinned = async () => {
    if (!bridge?.setPinned) return
    const next = !pinned
    setPinned(next)
    try {
      const result = await bridge.setPinned(next)
      if (typeof result === 'boolean') setPinned(result)
    } catch {
      setPinned(!next)
    }
  }

  const label = pinned ? '取消置顶' : '始终置顶'

  return (
    <header
      className="desktop-titlebar desktop-titlebar--plain"
      aria-label="打电话"
      data-testid="desktop-titlebar"
    >
      <span className="desktop-titlebar-name">打电话</span>
      {bridge?.setPinned && (
        <div className="desktop-titlebar-actions desktop-titlebar-actions--end">
          <button
            type="button"
            className="desktop-titlebar-pin"
            aria-label={label}
            title={label}
            aria-pressed={pinned}
            data-testid="ai-call-pin-toggle"
            onClick={() => void togglePinned()}
          >
            {pinned ? (
              <RiPushpinFill size={14} aria-hidden="true" />
            ) : (
              <RiPushpinLine size={14} aria-hidden="true" />
            )}
            <span>{label}</span>
          </button>
        </div>
      )}
    </header>
  )
}
