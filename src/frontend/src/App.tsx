import '@livekit/components-styles'
import '@/styles/index.css'
import { Suspense } from 'react'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { QueryClientProvider } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useTitle } from 'hoofd'
import { Switch, Route, Redirect } from 'wouter'
import { I18nProvider } from 'react-aria-components'
import { Layout } from './layout/Layout'
import { NotFoundScreen } from './components/NotFoundScreen'
import { ConfirmProvider } from './components/ConfirmProvider'
import { routes } from './routes'
import './i18n/init'
import { queryClient } from '@/api/queryClient'
import { AppInitialization } from '@/components/AppInitialization'
import { useIsSdkContext } from '@/features/sdk/hooks/useIsSdkContext'
import { useApplyA11yFonts } from '@/hooks/useApplyA11yFonts'
import { useUser } from '@/features/auth'

/**
 * Root "/" lands logged-in users on 消息 (/im) and anonymous visitors on the
 * 视频会议 home (/meeting), which still carries the login prompt / external-home
 * redirect. Renders nothing until auth resolves to avoid a wrong-way flash.
 */
const RootRedirect = () => {
  const { isLoggedIn } = useUser()
  if (isLoggedIn === undefined) return null
  return <Redirect to={isLoggedIn ? '/im' : '/meeting'} replace />
}

function App() {
  const { i18n } = useTranslation()
  useTitle(import.meta.env.VITE_APP_TITLE ?? '')

  const isSDKContext = useIsSdkContext()
  useApplyA11yFonts()

  return (
    <QueryClientProvider client={queryClient}>
      {!isSDKContext && <AppInitialization />}
      <Suspense fallback={null}>
        <I18nProvider locale={i18n.language}>
          <ConfirmProvider>
            <Layout>
              <Switch>
                {/* 根路径:登录用户进消息,匿名进视频会议主页(含登录引导)。 */}
                <Route path="/">
                  <RootRedirect />
                </Route>
                {Object.entries(routes).map(([, route], i) => (
                  <Route key={i} path={route.path} component={route.Component} />
                ))}
                <Route component={NotFoundScreen} />
              </Switch>
            </Layout>
          </ConfirmProvider>
          <ReactQueryDevtools
            initialIsOpen={false}
            buttonPosition="bottom-left"
          />
        </I18nProvider>
      </Suspense>
    </QueryClientProvider>
  )
}

export default App
