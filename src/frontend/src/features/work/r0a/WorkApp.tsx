import { useTranslation } from 'react-i18next'
import {
  Link,
  Redirect,
  Route,
  Switch,
  useLocation,
  useSearchParams,
} from 'wouter'
import {
  RiArchiveLine,
  RiBriefcaseLine,
  RiHome5Line,
  RiListCheck3,
  RiRefreshLine,
  RiSettings3Line,
} from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { RequireAuth } from '@/components/RequireAuth'
import { Button } from '@/primitives/Button'
import { Screen } from '@/layout/Screen'
import { css, cx } from '@/styled-system/css'
import { WorkApiError } from './api/client'
import { useWorkBootstrap } from './api/queries'
import { AdminPage } from './routes/AdminPage'
import { ArchivePage } from './routes/ArchivePage'
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

const HomePage = () => <WorkHomePage />
const NewWorkPage = () => <WorkHomePage composerOpen />

const WorkApp = () => {
  const { t } = useTranslation('work')
  const [searchParams] = useSearchParams()
  const [location] = useLocation()
  const legacyTask = location === '/work' ? searchParams.get('task') : null
  const legacyView = location === '/work' ? searchParams.get('view') : null
  const bootstrapQ = useWorkBootstrap()

  if (legacyTask) {
    return (
      <Redirect
        to={`/work/archive?legacyTask=${encodeURIComponent(legacyTask)}`}
      />
    )
  }
  if (legacyView === 'new') return <Redirect to="/work/new" />
  if (legacyView === 'history') return <Redirect to="/work/archive" />
  if (
    legacyView &&
    ['pending', 'running', 'awaiting_acceptance', 'completed', 'all'].includes(
      legacyView
    )
  ) {
    return <Redirect to={`/work/items?view=${legacyView}`} />
  }
  if (legacyView) return <Redirect to="/work/items" />

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
      <WorkHeader
        orgName={bootstrapQ.data.org.name}
        role={bootstrapQ.data.org.role}
      />
      <Switch>
        <Route path="/admin/work" component={AdminPage} />
        <Route path="/work/archive" component={ArchivePage} />
        <Route path="/work/items/:taskId" component={TaskWorkspacePage} />
        <Route path="/work/items" component={MyWorkPage} />
        <Route path="/work/new" component={NewWorkPage} />
        <Route path="/work" component={HomePage} />
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

const WorkHeader = ({ orgName, role }: { orgName: string; role: string }) => {
  const { t } = useTranslation('work')
  const [location] = useLocation()
  const homeActive = location === '/work' || location === '/work/new'
  const itemsActive = location.startsWith('/work/items')
  const archiveActive = location.startsWith('/work/archive')
  const adminActive = location.startsWith('/admin/work')
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
        <Link
          href="/work/archive"
          className={cx(navLink, archiveActive ? navLinkActive : '')}
        >
          <RiArchiveLine size={16} aria-hidden="true" />
          {t('nav.archive')}
        </Link>
        {role === 'owner' || role === 'admin' ? (
          <Link
            href="/admin/work"
            className={cx(navLink, adminActive ? navLinkActive : '')}
          >
            <RiSettings3Line size={16} aria-hidden="true" />
            {t('nav.admin')}
          </Link>
        ) : null}
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
