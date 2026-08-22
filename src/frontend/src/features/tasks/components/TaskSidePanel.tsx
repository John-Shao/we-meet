import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTask, ApiTaskLabel } from '../api/ApiTask'
import { usePatchTask, useTask } from '../api/fetchTasks'
import { nextTaskStatuses, taskDisplayName } from '../taskUi'
import { TaskLabelBadge } from './TaskLabelBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskForm } from './TaskForm'
import {
  TaskAttachmentsSection,
  TaskCommentsSection,
  TaskHistorySection,
  TaskSubtasksSection,
} from './TaskCollaborationSections'

type DetailTab =
  | 'overview'
  | 'subtasks'
  | 'comments'
  | 'attachments'
  | 'history'

const detailTabs: DetailTab[] = [
  'overview',
  'subtasks',
  'comments',
  'attachments',
  'history',
]

export const CreateTaskPanel = ({
  labels,
  onClose,
  onCreated,
}: {
  labels: ApiTaskLabel[]
  onClose: () => void
  onCreated: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <PanelShell title={t('workspace.createTitle')} onClose={onClose}>
      <TaskForm
        mode="create"
        labels={labels}
        onCancel={onClose}
        onSaved={onCreated}
      />
    </PanelShell>
  )
}

export const TaskDetailPanel = ({
  taskId,
  fallbackTask,
  labels,
  onClose,
}: {
  taskId: string
  fallbackTask?: ApiTask
  labels: ApiTaskLabel[]
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTask(taskId)
  const task = data || fallbackTask
  const [tab, setTab] = useState<DetailTab>('overview')
  const [editing, setEditing] = useState(false)
  const patchMutation = usePatchTask()

  useEffect(() => {
    setTab('overview')
    setEditing(false)
  }, [taskId])

  if (!task && isLoading) {
    return (
      <PanelShell title={t('workspace.details')} onClose={onClose}>
        <p className={stateCss}>{t('loading')}</p>
      </PanelShell>
    )
  }
  if (!task || error) {
    return (
      <PanelShell title={t('workspace.details')} onClose={onClose}>
        <p role="alert" className={errorCss}>
          {t('workspace.detailError')}
        </p>
      </PanelShell>
    )
  }

  const formatDate = (value: string | null) => {
    if (!value) return t('meta.none')
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
    }).format(new Date(year, month - 1, day))
  }

  return (
    <PanelShell title={task.title} onClose={onClose}>
      <nav aria-label={t('workspace.detailSections')} className={tabsCss}>
        {detailTabs.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={tab === value ? 'page' : undefined}
            className={tabButtonCss}
            data-active={tab === value || undefined}
            onClick={() => {
              setEditing(false)
              setTab(value)
            }}
          >
            {t(`workspace.tabs.${value}`)}
          </button>
        ))}
      </nav>
      <div className={panelBodyCss}>
        {editing ? (
          <TaskForm
            key={task.updated_at}
            mode="edit"
            task={task}
            labels={labels}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
          />
        ) : tab === 'overview' ? (
          <div className={overviewCss}>
            <div className={betweenCss}>
              <span className={statusCss}>{t(`statuses.${task.status}`)}</span>
              <TaskPriorityBadge priority={task.priority} />
            </div>
            <p className={descriptionCss}>
              {task.description || t('workspace.emptyDescription')}
            </p>
            <div className={labelRowCss}>
              {task.labels.map((label) => (
                <TaskLabelBadge key={label.id} label={label} />
              ))}
            </div>
            <dl className={metaGridCss}>
              <TaskMeta
                label={t('meta.assignee')}
                value={taskDisplayName(task.assignee)}
              />
              <TaskMeta
                label={t('meta.creator')}
                value={taskDisplayName(task.creator)}
              />
              <TaskMeta
                label={t('meta.startDate')}
                value={formatDate(task.start_date)}
              />
              <TaskMeta
                label={t('meta.dueDate')}
                value={formatDate(task.due_date)}
              />
            </dl>
            {task.source_room_id && (
              <Link
                href={`/meetings/${task.source_room_id}`}
                className={sourceLinkCss}
              >
                {t('sourceMeeting', {
                  name: task.source_room_name || t('meeting'),
                })}
              </Link>
            )}
            <div className={actionsCss}>
              {task.can_edit && (
                <Button variant="secondary" onPress={() => setEditing(true)}>
                  {t('actions.edit')}
                </Button>
              )}
              {task.can_update_status &&
                nextTaskStatuses(task).map((status) => (
                  <Button
                    key={status}
                    variant={status === 'completed' ? 'primary' : 'secondary'}
                    isDisabled={patchMutation.isPending}
                    onPress={() =>
                      patchMutation.mutate({
                        taskId: task.id,
                        patch: { status },
                      })
                    }
                  >
                    {t(`actions.to_${status}`)}
                  </Button>
                ))}
            </div>
            {patchMutation.error && (
              <p role="alert" className={errorCss}>
                {t('error')}
              </p>
            )}
          </div>
        ) : tab === 'subtasks' ? (
          <TaskSubtasksSection taskId={task.id} />
        ) : tab === 'comments' ? (
          <TaskCommentsSection taskId={task.id} />
        ) : tab === 'attachments' ? (
          <TaskAttachmentsSection taskId={task.id} />
        ) : (
          <TaskHistorySection taskId={task.id} />
        )}
      </div>
    </PanelShell>
  )
}

const PanelShell = ({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) => {
  const { t } = useTranslation('tasks')
  return (
    <aside aria-label={title} className={panelCss}>
      <header className={panelHeaderCss}>
        <h2 className={panelTitleCss}>{title}</h2>
        <button
          type="button"
          className={closeCss}
          aria-label={t('workspace.closePanel')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </aside>
  )
}

const TaskMeta = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className={metaLabelCss}>{label}</dt>
    <dd className={metaValueCss}>{value}</dd>
  </div>
)

const panelCss = css({
  height: '100%',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'greyscale.000',
  borderLeft: '1px solid token(colors.greyscale.200)',
  color: 'default.text',
})
const panelHeaderCss = css({
  minHeight: '4rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const panelTitleCss = css({
  margin: 0,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '1rem',
  fontWeight: '600',
})
const closeCss = css({
  border: 0,
  background: 'transparent',
  color: 'default.subtle-text',
  cursor: 'pointer',
  fontSize: '1.5rem',
  lineHeight: 1,
})
const tabsCss = css({
  display: 'flex',
  gap: '0.25rem',
  overflowX: 'auto',
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const tabButtonCss = css({
  flexShrink: 0,
  border: 0,
  borderRadius: '6px',
  padding: '0.5rem 0.625rem',
  backgroundColor: 'transparent',
  color: 'default.subtle-text',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  '&[data-active]': {
    backgroundColor: 'primary.50',
    color: 'primary.700',
    fontWeight: '600',
  },
})
const panelBodyCss = css({ flex: 1, minHeight: 0, overflowY: 'auto' })
const overviewCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem',
})
const betweenCss = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
})
const statusCss = css({
  borderRadius: '999px',
  paddingX: '0.625rem',
  paddingY: '0.25rem',
  backgroundColor: 'primary.50',
  color: 'primary.700',
  fontSize: '0.75rem',
  fontWeight: '600',
})
const descriptionCss = css({
  margin: 0,
  color: 'default.text',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const labelRowCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' })
const metaGridCss = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '1rem',
  margin: 0,
})
const metaLabelCss = css({ color: 'default.subtle-text', fontSize: '0.75rem' })
const metaValueCss = css({ margin: 0, color: 'default.text' })
const sourceLinkCss = css({ color: 'primary.600', textDecoration: 'none' })
const actionsCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' })
const stateCss = css({ margin: '1rem', color: 'default.subtle-text' })
const errorCss = css({ margin: '1rem', color: 'danger.subtle-text' })
