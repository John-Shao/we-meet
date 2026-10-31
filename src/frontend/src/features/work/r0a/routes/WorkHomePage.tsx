import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import { RiArrowRightLine, RiBriefcaseLine } from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkBootstrap, useWorkTasks } from '../api/queries'
import { Composer } from '../components/Composer'
import { TaskCard } from '../components/TaskCard'
import { useReadOnlyViewport } from '../hooks/useReadOnlyViewport'
import { card, muted, notice, page, row, sectionTitle } from '../ui'

export const WorkHomePage = ({
  composerOpen = false,
}: {
  composerOpen?: boolean
}) => {
  const { t } = useTranslation('work')
  const bootstrapQ = useWorkBootstrap()
  const tasksQ = useWorkTasks('all')
  const readOnly = useReadOnlyViewport()
  const recent = tasksQ.data?.pages[0]?.items.slice(0, 3) ?? []

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
