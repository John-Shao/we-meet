import { type ReactNode, useState } from 'react'
import { css } from '@/styled-system/css'
import { Header } from './Header'
import { layoutStore } from '@/stores/layout'
import { useSnapshot } from 'valtio'
import { Footer } from '@/layout/Footer'
import { ScreenReaderAnnouncer } from '@/primitives'
import { SkipLink, MAIN_CONTENT_ID } from './SkipLink'
import { useUser } from '@/features/auth'
import { AppRail } from './AppRail'
import { ResizablePanel } from '@/components/ResizablePanel'
import { ImUnreadProvider } from '@/features/im/components/ImUnreadProvider'

export type Layout = 'fullpage' | 'centered'

/**
 * Layout component for the app.
 *
 * This component is meant to be used as a wrapper around the whole app.
 * In a specific page, use the `Screen` component and change its props to change global page layout.
 */
export const Layout = ({ children }: { children: ReactNode }) => {
  const layoutSnap = useSnapshot(layoutStore)
  const showHeader = layoutSnap.showHeader
  const showFooter = layoutSnap.showFooter
  const { isLoggedIn } = useUser()

  // P6-e: collapsible primary rail (new-Feishu). Collapsed → fixed icon strip
  // (resize disabled); expanded → user-resizable. Persisted across sessions.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('we-meet:rail-collapsed') === '1'
  )
  const toggleRail = () =>
    setRailCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('we-meet:rail-collapsed', next ? '1' : '0')
      } catch {
        /* private mode — applies for this session only */
      }
      return next
    })

  // P6: logged-in workspace routes get the Feishu-style left rail (column 1).
  //
  // 关键(2026-07-18 根治「布局分支切换重挂 children」):这里按 isLoggedIn 分支,
  // 而 *不* 按 showHeader。showHeader 只决定 rail / SkipLink 的显隐——它们是
  // <main> 的位置兄弟节点,增删不影响 React 对 <main>(以及其中 {children})的
  // 按位复用,故 showHeader 翻转(如预览页带栏 → 进房全屏)不再卸载重挂路由组件,
  // 路由内 state(如 Room.hasSubmittedEntry)得以保留,点「加入」不再弹回预览。
  //
  // 附带效果:ImUnreadProvider 在会中(showHeader=false)也保持挂载,IM 连接与
  // 来电浮层(CallOverlay,本就声明「ring on ANY page」)全程常驻——先前它被意外
  // 关在带栏分支里,会中收不到 1:1 来电,这里一并补上。仅 isLoggedIn 边界(登录/
  // 登出)才换根分支,那本就要整页重载,重挂无妨。
  if (isLoggedIn) {
    return (
      <ImUnreadProvider>
        {showHeader && <SkipLink />}
        <div
          className={css({
            display: 'flex',
            height: '100%',
            backgroundColor: 'primary.50',
            color: 'default.text',
          })}
        >
          {showHeader &&
            (railCollapsed ? (
              <div
                className={css({ flexShrink: 0, height: '100%' })}
                style={{ width: 64 }}
              >
                <AppRail collapsed onToggleCollapse={toggleRail} />
              </div>
            ) : (
              <ResizablePanel
                storageKey="we-meet:app-rail-width"
                defaultWidth={210}
                min={180}
                max={320}
              >
                <AppRail onToggleCollapse={toggleRail} />
              </ResizablePanel>
            ))}
          <main
            id={MAIN_CONTENT_ID}
            className={css({
              flexGrow: 1,
              minWidth: 0,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'greyscale.000',
            })}
          >
            <ScreenReaderAnnouncer />
            {children}
          </main>
        </div>
      </ImUnreadProvider>
    )
  }

  return (
    <>
      {showHeader && <SkipLink />}
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'greyscale.000',
          color: 'default.text',
          flex: '1',
        })}
        style={{
          height: !showFooter ? '100%' : undefined,
        }}
      >
        {showHeader && <Header />}
        <main
          id={MAIN_CONTENT_ID}
          className={css({
            flexGrow: 1,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          })}
        >
          <ScreenReaderAnnouncer />
          {children}
        </main>
      </div>
      {showFooter && <Footer />}
    </>
  )
}
