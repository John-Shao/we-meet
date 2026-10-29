import { useTranslation } from 'react-i18next'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'
import {
  RiBriefcaseLine,
  RiHome5Line,
  RiListCheck3,
  RiRefreshLine,
} from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { RequireAuth } from '@/components/RequireAuth'
import { Button } from '@/primitives/Button'
import { Screen } from '@/layout/Screen'
import { css, cx } from '@/styled-system/css'
import { WorkApiError } from './api/client'
import { useWorkBootstrap } from './api/queries'
import { MyWorkPage } from './routes/MyWorkPage'
import { TaskWorkspacePage } from './routes/TaskWorkspacePage'
import { WorkHomePage } from './routes/WorkHomePage'
import { page } from './ui'

export const WorkRoute = () => (
  <RequireAuth>
    <Screen footer={false}>
      <WorkApp />
    </Screen>
  </RequireAuth>
)

const WorkApp = () => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()

  if (bootstrapQ.isLoading) {
    return (
      <div className={page}>
        <p className={css({ color: 'text.secondary' })}>{t('loading')}</p>
      </div>
    )
  }
  if (bootstrapQ.isError || !bootstrapQ.data) {
    const error = bootstrapQ.error
    const apiError = error instanceof WorkApiError ? error : undefined
    const noSeat =
      apiError?.code === 'work_seat_required' ||
      apiError?.code === 'forbidden' ||
      apiError?.status === 403
    return (
      <div className={page}>
        <PageState
          state="error"
          icon={<RiRefreshLine size={20} aria-hidden="true" />}
          title={noSeat ? t('unavailable.title') : t('errors.bootstrapTitle')}
          description={
            noSeat
              ? t('unavailable.description')
              : t('errors.bootstrapDescription')
          }
          action={
            <Button
              variant="secondary"
              size="dense"
              onPress={() => bootstrapQ.refetch()}
            >
              {t('retry')}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
      })}
    >
      <WorkHeader orgName={bootstrapQ.data.org.name} />
      <Switch>
        <Route path="/work/items/:taskId" component={TaskWorkspacePage} />
        <Route path="/work/items" component={MyWorkPage} />
        <Route path="/work/new" component={WorkHomePage} />
        <Route path="/work" component={WorkHomePage} />
        <Route>
          <Redirect to="/work" />
        </Route>
      </Switch>
    </div>
  )
}

const header = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'lg',
  paddingX: { base: 'md', md: 'xl' },
  paddingY: 'sm',
  borderBottom: '1px solid token(colors.border.subtle)',
  backgroundColor: 'surface.default',
  flexWrap: 'wrap',
})

const navLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'xxs',
  paddingX: 'sm',
  paddingY: 'xs',
  borderRadius: 'control',
  textDecoration: 'none',
  textStyle: 'bodyMedium',
  color: 'text.secondary',
  _hover: { backgroundColor: 'surface.canvas' },
})

const navLinkActive = css({
  color: 'text.primary',
  backgroundColor: 'surface.canvas',
  fontWeight: 'semibold',
})

const WorkHeader = ({ orgName }: { orgName: string }) => {
  const { t } = useTranslation('work')
  const [location] = useLocation()
  const homeActive = location === '/work' || location === '/work/new'
  const itemsActive = location.startsWith('/work/items')
  return (
    <header className={header}>
      <span
        className={css({
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'xs',
          textStyle: 'titleMedium',
          fontWeight: 'bold',
        })}
      >
        <RiBriefcaseLine size={20} aria-hidden="true" />
        {t('title')}
      </span>
      <nav
        aria-label={t('nav.label')}
        className={css({ display: 'flex', alignItems: 'center', gap: 'xxs' })}
      >
        <Link
          href="/work"
          className={cx(navLink, homeActive ? navLinkActive : '')}
        >
          <RiHome5Line size={16} aria-hidden="true" />
          {t('nav.home')}
        </Link>
        <Link
          href="/work/items?view=all"
          className={cx(navLink, itemsActive ? navLinkActive : '')}
        >
          <RiListCheck3 size={16} aria-hidden="true" />
          {t('nav.items')}
        </Link>
      </nav>
      <span
        className={css({
          marginLeft: 'auto',
          color: 'text.secondary',
          textStyle: 'bodyMedium',
        })}
      >
        {orgName}
      </span>
    </header>
  )
}
