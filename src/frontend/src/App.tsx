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
import { useApplyTheme } from '@/hooks/useApplyTheme'
import { useUser } from '@/features/auth'
import { HomeRoute } from '@/features/home'

/**
 * Root "/" is the login landing: logged-in users go straight to 消息 (/im),
 * anonymous visitors stay here and see the login page (Home's anonymous state,
 * which carries the login entry + external-home redirect). Renders nothing
 * until auth resolves to avoid a wrong-way flash. The 视频会议 home lives at
 * /meeting (logged-in workspace).
 */
const RootGate = () => {
  const { isLoggedIn } = useUser()
  if (isLoggedIn === undefined) return null
  if (isLoggedIn) return <Redirect to="/im" replace />
  return <HomeRoute />
}

function App() {
  const { i18n } = useTranslation()
  useTitle(import.meta.env.VITE_APP_TITLE ?? '')

  const isSDKContext = useIsSdkContext()
  useApplyA11yFonts()
  useApplyTheme()

  return (
    <QueryClientProvider client={queryClient}>
      {!isSDKContext && <AppInitialization />}
      <Suspense fallback={null}>
        <I18nProvider locale={i18n.language}>
          <ConfirmProvider>
            <Layout>
              <Switch>
                {/* 根路径=登录落地:登录用户进消息,匿名显示登录页面。 */}
                <Route path="/">
                  <RootGate />
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
