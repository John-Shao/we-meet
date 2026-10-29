import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { css } from '@/styled-system/css'
import type { WorkTaskSummary } from '../api/types'
import { muted } from '../ui'
import { TaskStatusBadge } from './TaskStatusBadge'

const cardLink = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  padding: 'md',
  borderBottom: '1px solid token(colors.border.subtle)',
  color: 'inherit',
  textDecoration: 'none',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: { outline: '2px solid token(colors.border.focus)' },
})

export const TaskCard = ({ task }: { task: WorkTaskSummary }) => {
  const { t, i18n } = useTranslation('work')
  const updated = new Date(task.updated_at).toLocaleString(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return (
    <Link
      href={`/work/items/${encodeURIComponent(task.task_id)}`}
      className={cardLink}
    >
      <span
        className={css({ display: 'flex', alignItems: 'center', gap: 'sm' })}
      >
        <span
          className={css({
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 'semibold',
            textStyle: 'bodyMedium',
          })}
        >
          {task.title}
        </span>
        <TaskStatusBadge state={task.display_state} />
      </span>
      <span className={css({ display: 'flex', gap: 'md', flexWrap: 'wrap' })}>
        <span className={muted}>{t('items.updatedAt', { time: updated })}</span>
        {task.latest_run ? (
          <span className={muted}>
            {t('items.runState', {
              state: t(`run.${task.latest_run.state}`, {
                defaultValue: task.latest_run.state,
              }),
            })}
          </span>
        ) : null}
        {task.latest_artifact ? (
          <span className={muted}>
            {t('items.artifact', { version: task.latest_artifact.version_no })}
          </span>
        ) : null}
      </span>
    </Link>
  )
}
