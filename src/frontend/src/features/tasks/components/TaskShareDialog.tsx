import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { css } from '@/styled-system/css'

import type { ApiTask } from '../api/ApiTask'
import { shareTaskToConversations } from '../api/fetchTasks'
import { buildTaskCardBody, buildTaskLink } from './taskCard'

export const TaskShareDialog = ({
  task,
  sharedVia,
  onClose,
}: {
  task: ApiTask
  sharedVia?: string
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const [copied, setCopied] = useState(false)
  const link = useMemo(() => buildTaskLink(task.id), [task.id])

  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <ShareToChatDialog
      body=""
      contentType="rich-card"
      previewText={task.title}
      title={t('share.title', { title: task.title })}
      primaryTabLabel={t('share.toConversation')}
      secondaryTab={{
        label: t('share.taskLink'),
        content: (
          <div className={linkPaneCss}>
            <p>{t('share.linkHint')}</p>
            <div className={linkRowCss}>
              <input readOnly value={link} aria-label={t('share.taskLink')} />
              <button type="button" onClick={() => void copy()}>
                {copied ? t('share.copied') : t('share.copy')}
              </button>
            </div>
          </div>
        ),
      }}
      beforeSend={async (cids) => {
        await shareTaskToConversations(task.id, cids, sharedVia)
      }}
      onSent={() => undefined}
      errorMessage={t('share.failed')}
      onClose={onClose}
      buildBody={(cid) => buildTaskCardBody(task, cid, t, i18n.language)}
    />
  )
}

const linkPaneCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  '& p': { margin: 0, color: 'greyscale.600', fontSize: '0.8125rem' },
})

const linkRowCss = css({
  display: 'flex',
  gap: '0.5rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.100',
  '& input': {
    flex: 1,
    minWidth: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: 'greyscale.800',
  },
  '& button': {
    flexShrink: 0,
    paddingX: '0.875rem',
    border: '1px solid token(colors.greyscale.300)',
    borderRadius: '6px',
    backgroundColor: 'greyscale.000',
    cursor: 'pointer',
  },
})
