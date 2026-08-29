import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RiArrowRightSLine } from '@remixicon/react'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import { useTaskActivityFeed } from '../api/fetchTasks'
import { taskActivityMessage } from '../taskActivityMessage'
import { TaskHistoryListSkeleton } from './TaskSkeletons'
import { TaskUserAvatar } from './TaskUserDisplay'

export const TaskActivityDialog = ({
  onClose,
  onOpenTask,
}: {
  onClose: () => void
  onOpenTask: (taskId: string) => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useTaskActivityFeed()
  const activities = useMemo(
    () => data?.pages.flatMap((page) => page.results) || [],
    [data]
  )

  return (
    <Modal
      ariaLabel={t('activity.title')}
      onClose={onClose}
      maxWidth="720px"
      maxHeight="82vh"
    >
      <div className={headerCss}>
        <div>
          <h2>{t('activity.title')}</h2>
          <p>{t('activity.description')}</p>
        </div>
        <ModalCloseButton label={t('activity.close')} onClose={onClose} />
      </div>
      <div className={contentCss}>
        {isLoading ? (
          <TaskHistoryListSkeleton label={t('activity.loading')} />
        ) : error ? (
          <div className={stateCss}>
            <StateHint>{t('activity.error')}</StateHint>
            <Button variant="secondary" size="action" onPress={() => refetch()}>
              {t('workspace.retry')}
            </Button>
          </div>
        ) : activities.length === 0 ? (
          <StateHint>{t('activity.empty')}</StateHint>
        ) : (
          <ol className={feedCss}>
            {activities.map((activity) => (
              <li key={activity.id}>
                <button
                  type="button"
                  aria-label={t('activity.openTask', {
                    title: activity.task_title,
                  })}
                  onClick={() => onOpenTask(activity.task_id)}
                >
                  <TaskUserAvatar user={activity.actor} size="1.75rem" />
                  <span className={activityContentCss}>
                    <strong>{activity.task_title}</strong>
                    <span>{taskActivityMessage(activity, t)}</span>
                    <time dateTime={activity.created_at}>
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(activity.created_at))}
                    </time>
                  </span>
                  <RiArrowRightSLine size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        )}
        {hasNextPage && (
          <div className={loadMoreCss}>
            <Button
              variant="secondary"
              size="action"
              loading={isFetchingNextPage}
              onPress={() => fetchNextPage()}
            >
              {t(
                isFetchingNextPage
                  ? 'activity.loadingMore'
                  : 'activity.loadMore'
              )}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

const headerCss = css({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem 1.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& h2': { margin: 0, fontSize: '1.125rem' },
  '& p': {
    margin: '0.25rem 0 0',
    color: 'greyscale.600',
    fontSize: '0.8125rem',
  },
})

const contentCss = css({
  minHeight: '12rem',
  padding: '0.5rem 1.25rem 1rem',
  overflowY: 'auto',
})

const feedCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  '& li:not(:last-child)': {
    borderBottom: '1px solid token(colors.greyscale.100)',
  },
  '& button': {
    width: '100%',
    minHeight: '5rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    paddingY: '0.75rem',
    border: 0,
    backgroundColor: 'transparent',
    color: 'greyscale.800',
    cursor: 'pointer',
    textAlign: 'left',
    _hover: { backgroundColor: 'greyscale.100' },
    _focusVisible: {
      outline: '2px solid token(colors.primary.400)',
      outlineOffset: '-2px',
    },
  },
  '& button > svg': { flexShrink: 0, color: 'greyscale.500' },
})

const activityContentCss = css({
  minWidth: 0,
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  '& strong': {
    overflow: 'hidden',
    color: 'greyscale.900',
    fontSize: '0.875rem',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '& > span': { color: 'greyscale.700', fontSize: '0.8125rem' },
  '& time': { color: 'greyscale.500', fontSize: '0.75rem' },
})

const stateCss = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingBottom: '1rem',
})

const loadMoreCss = css({
  display: 'flex',
  justifyContent: 'center',
  paddingTop: '1rem',
})
