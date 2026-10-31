import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'wouter'
import { RiArchiveLine, RiFileList3Line, RiRefreshLine } from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { PageState } from '@/components/PageState'
import { css } from '@/styled-system/css'
import { useWorkTasks } from '../api/queries'
import { TaskCard } from '../components/TaskCard'
import { card, muted, notice, page } from '../ui'

export const ArchivePage = () => {
  const { t } = useTranslation('work')
  const [searchParams] = useSearchParams()
  const legacyTask = searchParams.get('legacyTask')
  const tasksQ = useWorkTasks('all')
  const items = legacyTask
    ? []
    : (tasksQ.data?.pages
        .flatMap((item) => item.items)
        .filter((task) => task.display_state === 'archived') ?? [])

  return (
    <div className={page}>
      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      >
        <h1 className={css({ margin: 0, textStyle: 'titleLarge' })}>
          {t('archive.title')}
        </h1>
        <p className={muted}>{t('archive.subtitle')}</p>
      </div>

      {legacyTask ? (
        <p className={notice}>
          {t('archive.legacyNotice', { task: legacyTask })}
        </p>
      ) : null}

      <section className={card}>
        {legacyTask ? null : tasksQ.isLoading ? (
          <p className={muted}>{t('loading')}</p>
        ) : tasksQ.isError ? (
          <PageState
            state="error"
            density="compact"
            icon={<RiRefreshLine size={20} aria-hidden="true" />}
            title={t('archive.errorTitle')}
            description={t('archive.errorDescription')}
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
            title={t('archive.emptyTitle')}
            description={t('archive.emptyDescription')}
          />
        ) : (
          <div className={css({ marginX: '-1rem' })}>
            {items.map((task) => (
              <TaskCard key={task.task_id} task={task} />
            ))}
          </div>
        )}
      </section>

      <p className={muted}>
        <RiArchiveLine size={16} aria-hidden="true" /> {t('archive.readOnly')}
      </p>
    </div>
  )
}
