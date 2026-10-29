import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'wouter'
import { RiFileList3Line, RiRefreshLine } from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import { useWorkTasks } from '../api/queries'
import type { WorkTaskView } from '../api/types'
import { TaskCard } from '../components/TaskCard'
import { card, muted, page } from '../ui'

const VIEWS: WorkTaskView[] = [
  'pending',
  'running',
  'awaiting_acceptance',
  'completed',
  'all',
]

export const MyWorkPage = () => {
  const { t } = useTranslation('work')
  const [searchParams] = useSearchParams()
  const raw = searchParams.get('view')
  const view = VIEWS.includes(raw as WorkTaskView)
    ? (raw as WorkTaskView)
    : 'all'
  const tasksQ = useWorkTasks(view)
  const items = tasksQ.data?.pages.flatMap((item) => item.items) ?? []

  return (
    <div className={page}>
      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      >
        <h1 className={css({ margin: 0, textStyle: 'titleLarge' })}>
          {t('items.title')}
        </h1>
        <p className={muted}>{t('items.subtitle')}</p>
      </div>

      <nav
        aria-label={t('items.views')}
        className={css({
          display: 'flex',
          gap: 'xxs',
          flexWrap: 'wrap',
          borderBottom: '1px solid token(colors.border.subtle)',
          paddingBottom: 'xs',
        })}
      >
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`/work/items?view=${item}`}
            aria-current={item === view ? 'page' : undefined}
            className={css({
              paddingX: 'sm',
              paddingY: 'xs',
              borderRadius: 'control',
              textDecoration: 'none',
              textStyle: 'bodyMedium',
              color: item === view ? 'text.primary' : 'text.secondary',
              backgroundColor: item === view ? 'surface.canvas' : 'transparent',
              fontWeight: item === view ? 'semibold' : 'normal',
              _hover: { backgroundColor: 'surface.canvas' },
            })}
          >
            {t(`items.view.${item}`)}
          </Link>
        ))}
      </nav>

      <section className={card}>
        {tasksQ.isLoading ? (
          <p className={muted}>{t('loading')}</p>
        ) : tasksQ.isError ? (
          <PageState
            state="error"
            density="compact"
            icon={<RiRefreshLine size={20} aria-hidden="true" />}
            title={t('items.errorTitle')}
            description={t('items.errorDescription')}
            action={
              <Button
                variant="secondary"
                size="dense"
                onPress={() => tasksQ.refetch()}
              >
                {t('retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <PageState
            density="compact"
            icon={<RiFileList3Line size={20} aria-hidden="true" />}
            title={t(`items.empty.${view}.title`)}
            description={t(`items.empty.${view}.description`)}
          />
        ) : (
          <div className={css({ marginX: '-1rem' })}>
            {items.map((task) => (
              <TaskCard key={task.task_id} task={task} />
            ))}
          </div>
        )}
      </section>

      {tasksQ.hasNextPage ? (
        <div className={css({ display: 'flex', justifyContent: 'center' })}>
          <Button
            variant="secondary"
            loading={tasksQ.isFetchingNextPage}
            onPress={() => tasksQ.fetchNextPage()}
          >
            {t('items.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
