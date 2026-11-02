import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { css } from '@/styled-system/css'
import type { WorkInboxItem } from '../api/types'
import { TaskStatusBadge } from './TaskStatusBadge'

const link = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  padding: 'md',
  borderBottom: '1px solid token(colors.border.subtle)',
  color: 'inherit',
  textDecoration: 'none',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: { outline: '2px solid token(colors.border.focus)' },
})

const title = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 'semibold',
  textStyle: 'bodyMedium',
})

// InboxCard is TaskCard's lighter sibling: the projection carries no run, quota
// or artifact detail on purpose, because the page's job is to say which tasks are
// waiting on the owner and get them into the workspace in one click.
export const InboxCard = ({ item }: { item: WorkInboxItem }) => {
  const { t, i18n } = useTranslation('work')
  const updated = new Date(item.updated_at).toLocaleString(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  return (
    <Link
      href={`/work/items/${encodeURIComponent(item.task_id)}`}
      className={link}
    >
      <span className={title}>{item.title}</span>
      <TaskStatusBadge state={item.display_state} />
      <span
        className={css({ color: 'text.secondary', textStyle: 'labelMedium' })}
      >
        {t('items.updatedAt', { time: updated })}
      </span>
    </Link>
  )
}
