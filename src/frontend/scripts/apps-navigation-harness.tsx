// Development-only fixture used by check-apps-navigation-ui.mjs.
import React, { Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import '../src/styles/index.css'
import '../src/i18n/init'
import { AppRail } from '../src/layout/AppRail'
import { AppsContent } from '../src/features/apps/AppsPage'

export async function mountAppsHarness() {
  if (!i18n.isInitialized)
    await new Promise((resolve) => i18n.on('initialized', resolve))
  await i18n.changeLanguage('zh')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['config'], {
    work: { enabled: true },
    docs: { url: '/docs' },
    livekit: {},
    background_image: {},
    subtitle: {},
    telephony: {},
  })
  client.setQueryData(['user'], {
    id: 'apps-ui-fixture',
    full_name: '应用验证',
    email: 'fixture@example.test',
  })
  const root = createRoot(document.getElementById('root')!)
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <Suspense fallback="Loading">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `${innerWidth < 768 ? 64 : 210}px minmax(0, 1fr)`,
              height: '100dvh',
            }}
          >
            <AppRail collapsed={innerWidth < 768} />
            <AppsContent ownerId="apps-ui-fixture" />
          </div>
        </Suspense>
      </QueryClientProvider>
    )
  Object.assign(window, { renderAppsHarness: render })
  render()
}
