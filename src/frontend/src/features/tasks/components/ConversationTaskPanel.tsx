import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
  RiCalendarLine,
  RiCloseLine,
  RiShareForwardLine,
  RiUser3Line,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTask } from '../api/ApiTask'
import { useConversationTasks } from '../api/fetchTasks'
import { formatTaskDate } from '../taskDateFormat'
import { taskAssignees } from '../taskUi'
import { TaskShareDialog } from './TaskShareDialog'
import { TaskAssigneesDisplay } from './TaskUserDisplay'

export const ConversationTaskPanel = ({
  cid,
  onClose,
}: {
  cid: string
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const [, navigate] = useLocation()
  const { data: tasks = [], isLoading, error } = useConversationTasks(cid)
  const [sharing, setSharing] = useState<ApiTask | null>(null)

  const openTask = (task: ApiTask) => {
    const params = new URLSearchParams({ task: task.id, shared_via: cid })
    navigate(`/tasks?${params.toString()}`)
  }

  return (
    <aside className={panelCss} aria-label={t('share.conversationTitle')}>
      <header className={headerCss}>
        <h2>{t('share.conversationTitle')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('workspace.closePanel')}
        >
          <RiCloseLine size={20} />
        </button>
      </header>
      <div className={bodyCss}>
        {isLoading ? (
          <p className={hintCss}>{t('share.loading')}</p>
        ) : error ? (
          <p className={hintCss} role="alert">
            {t('error')}
          </p>
        ) : tasks.length === 0 ? (
          <p className={hintCss}>{t('share.conversationEmpty')}</p>
        ) : (
          <ul className={listCss}>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={taskButtonCss}
                  onClick={() => openTask(task)}
                >
                  <strong>{task.title}</strong>
                  <span>
                    <RiUser3Line size={14} />
                    <TaskAssigneesDisplay users={taskAssignees(task)} />
                  </span>
                  <span>
                    <RiCalendarLine size={14} />
                    {task.due_date
                      ? formatTaskDate(task.due_date, i18n.language)
                      : t('meta.none')}
                  </span>
                </button>
                <Button
                  size="icon28"
                  variant="quaternaryText"
                  aria-label={t('share.action')}
                  tooltip={t('share.action')}
                  onPress={() => setSharing(task)}
                >
                  <RiShareForwardLine size={17} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className={footerCss}>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => navigate('/tasks')}
        >
          {t('share.viewMore')}
        </Button>
      </footer>
      {sharing && (
        <TaskShareDialog
          task={sharing}
          sharedVia={cid}
          onClose={() => setSharing(null)}
        />
      )}
    </aside>
  )
}

const panelCss = css({
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
})
const headerCss = css({
  minHeight: '3.25rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& h2': { margin: 0, fontSize: '1rem' },
  '& button': {
    border: 0,
    background: 'transparent',
    fontSize: '1.25rem',
    cursor: 'pointer',
  },
})
const bodyCss = css({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0.75rem',
})
const hintCss = css({
  margin: 0,
  padding: '1.5rem 0.5rem',
  color: 'greyscale.500',
  textAlign: 'center',
})
const listCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  '& li': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    border: '1px solid token(colors.greyscale.200)',
    borderRadius: '0.5rem',
  },
})
const taskButtonCss = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.375rem',
  padding: '0.75rem',
  border: 0,
  backgroundColor: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  '& strong': {
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '& span': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    color: 'greyscale.600',
    fontSize: '0.75rem',
  },
})
const footerCss = css({
  padding: '0.75rem 1rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
