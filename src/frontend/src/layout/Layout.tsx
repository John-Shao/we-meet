import { type ReactNode } from 'react'
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

  // P6: logged-in workspace routes get the Feishu-style left rail (column 1).
  // The in-call room (showHeader=false) and anonymous pages keep the original
  // top-Header / full-screen layout untouched.
  if (showHeader && isLoggedIn) {
    return (
      <>
        <SkipLink />
        <div
          className={css({
            display: 'flex',
            height: '100%',
            backgroundColor: 'primary.50',
            color: 'default.text',
          })}
        >
          <ResizablePanel
            storageKey="we-meet:app-rail-width"
            defaultWidth={210}
            min={180}
            max={320}
          >
            <AppRail />
          </ResizablePanel>
          <main
            id={MAIN_CONTENT_ID}
            className={css({
              flexGrow: 1,
              minWidth: 0,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'white',
            })}
          >
            <ScreenReaderAnnouncer />
            {children}
          </main>
        </div>
      </>
    )
  }

  return (
    <>
      {showHeader && <SkipLink />}
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'white',
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
