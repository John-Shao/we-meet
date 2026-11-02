import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import {
  RiArrowRightLine,
  RiBriefcaseLine,
  RiInboxLine,
} from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkBootstrap, useWorkInbox, useWorkTasks } from '../api/queries'
import { Composer } from '../components/Composer'
import { InboxCard } from '../components/InboxCard'
import { TaskCard } from '../components/TaskCard'
import { useReadOnlyViewport } from '../hooks/useReadOnlyViewport'
import { trackWorkEvent } from '../telemetry'
import { card, muted, notice, page, row, sectionTitle } from '../ui'

export const WorkHomePage = ({
  composerOpen = false,
}: {
  composerOpen?: boolean
}) => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const tasksQ = useWorkTasks('all')
  const inboxQ = useWorkInbox()
  const readOnly = useReadOnlyViewport()
  const recent = tasksQ.data?.pages[0]?.items.slice(0, 3) ?? []
  const inboxItems = inboxQ.data?.pages[0]?.items ?? []
  const inboxOpened = useRef(false)

  useEffect(() => {
    trackWorkEvent('work_r0a_home_view')
  }, [])

  // R0a has no inbox page: the 「需要你」 section on this page is the inbox, so
  // "opened" is the first render that actually has something to act on. The ref keeps
  // the 30s poll from turning one view into one event per refresh.
  useEffect(() => {
    if (inboxOpened.current || inboxItems.length === 0) return
    inboxOpened.current = true
    trackWorkEvent('inbox_open')
  }, [inboxItems.length])

  if (!bootstrapQ.data) return null

  return (
    <div className={page}>
      <section
        className={css({ display: 'flex', flexDirection: 'column', gap: 'sm' })}
      >
        <span
          className={css({ color: 'text.secondary', textStyle: 'bodyMedium' })}
        >
          {t('home.eyebrow')}
        </span>
        <h1 className={css({ margin: 0, textStyle: 'displaySmall' })}>
          {t('home.title')}
        </h1>
        <p className={muted}>{t('home.subtitle')}</p>
        <div className={row}>
          <Link
            href="/work/items?view=all"
            className={css({
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'xxs',
              color: 'text.link',
              textStyle: 'bodyMedium',
              fontWeight: 'semibold',
              textDecoration: 'none',
            })}
          >
            {t('home.viewAll')}
            <RiArrowRightLine size={14} aria-hidden="true" />
          </Link>
        </div>
      </section>

      {readOnly ? (
        <p className={notice} role="status">
          {t('readOnly.homeHint')}
        </p>
      ) : composerOpen ? (
        <Composer bootstrap={bootstrapQ.data} />
      ) : (
        <div className={row}>
          <Link href="/work/new">
            <Button variant="primary">{t('composer.title')}</Button>
          </Link>
        </div>
      )}

      <section
        className={css({ display: 'flex', flexDirection: 'column', gap: 'sm' })}
        aria-labelledby="work-needs-you"
      >
        <div
          className={css({ display: 'flex', alignItems: 'center', gap: 'xs' })}
        >
          <RiInboxLine size={16} aria-hidden="true" />
          <h2 id="work-needs-you" className={sectionTitle}>
            {t('home.needsYou')}
          </h2>
        </div>
        <div className={card}>
          {inboxQ.isLoading ? (
            <p className={muted}>{t('loading')}</p>
          ) : inboxQ.isError ? (
            <p className={muted}>{t('home.inboxUnavailable')}</p>
          ) : inboxItems.length === 0 ? (
            <p className={muted}>{t('home.emptyInbox')}</p>
          ) : (
            <div className={css({ marginX: '-1rem' })}>
              {inboxItems.map((item) => (
                <InboxCard key={item.task_id} item={item} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section
        className={css({ display: 'flex', flexDirection: 'column', gap: 'sm' })}
      >
        <div
          className={css({ display: 'flex', alignItems: 'center', gap: 'xs' })}
        >
          <RiBriefcaseLine size={16} aria-hidden="true" />
          <h2 className={sectionTitle}>{t('home.recent')}</h2>
        </div>
        <div className={card}>
          {tasksQ.isLoading ? (
            <p className={muted}>{t('loading')}</p>
          ) : recent.length === 0 ? (
            <p className={muted}>{t('home.emptyRecent')}</p>
          ) : (
            <div className={css({ marginX: '-1rem' })}>
              {recent.map((task) => (
                <TaskCard key={task.task_id} task={task} />
              ))}
            </div>
          )}
        </div>
        {recent.length > 0 ? (
          <div className={css({ display: 'flex', justifyContent: 'flex-end' })}>
            <Link href="/work/items?view=all">
              <Button variant="secondaryText" size="dense">
                {t('home.viewAll')}
              </Button>
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  )
}
