import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiCalendarLine,
  RiFileTextLine,
  RiFlagLine,
  RiPriceTag3Line,
  RiUser3Line,
  RiUserAddLine,
} from '@remixicon/react'

import { ModalCloseButton } from '@/components/Modal'
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

export const CreateTaskPanel = ({
  labels,
  titleInputRef,
  onClose,
  onCreated,
}: {
  labels: ApiTaskLabel[]
  titleInputRef?: RefObject<HTMLInputElement>
  onClose: () => void
  onCreated: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <>
      <header className={createDialogHeaderCss}>
        <h2>{t('workspace.createTitle')}</h2>
        <ModalCloseButton label={t('workspace.closePanel')} onClose={onClose} />
      </header>
      <TaskForm
        mode="create"
        labels={labels}
        titleInputRef={titleInputRef}
        onCancel={onClose}
        onSaved={onCreated}
      />
    </>
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
  const [editing, setEditing] = useState(false)
  const patchMutation = usePatchTask()

  useEffect(() => {
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
    <PanelShell title={t('workspace.details')} onClose={onClose}>
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
        ) : (
          <div className={detailContentCss}>
            <div className={taskTitleRowCss}>
              <span
                className={titleStatusCss}
                data-complete={task.status === 'completed' || undefined}
                aria-hidden="true"
              >
                {task.status === 'completed' ? '✓' : ''}
              </span>
              <div className={taskTitleTextCss}>
                <h2>{task.title}</h2>
                <span>{t(`statuses.${task.status}`)}</span>
              </div>
            </div>

            <div className={actionsCss}>
              {task.can_update_status &&
                nextTaskStatuses(task).map((status) => (
                  <Button
                    key={status}
                    size="dense"
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
              {task.can_edit && (
                <Button
                  size="dense"
                  variant="secondary"
                  onPress={() => setEditing(true)}
                >
                  {t('actions.edit')}
                </Button>
              )}
            </div>
            {patchMutation.error && (
              <p role="alert" className={inlineErrorCss}>
                {t('error')}
              </p>
            )}

            <dl className={propertyListCss}>
              <TaskProperty
                icon={<RiUser3Line size={18} />}
                label={t('meta.assignee')}
              >
                {taskDisplayName(task.assignee)}
              </TaskProperty>
              <TaskProperty
                icon={<RiUserAddLine size={18} />}
                label={t('meta.creator')}
              >
                {taskDisplayName(task.creator)}
              </TaskProperty>
              <TaskProperty
                icon={<RiCalendarLine size={18} />}
                label={`${t('meta.startDate')} / ${t('meta.dueDate')}`}
              >
                {formatDate(task.start_date)} — {formatDate(task.due_date)}
              </TaskProperty>
              <TaskProperty
                icon={<RiFlagLine size={18} />}
                label={t('form.priority')}
              >
                <TaskPriorityBadge priority={task.priority} />
              </TaskProperty>
              <TaskProperty
                icon={<RiPriceTag3Line size={18} />}
                label={t('labels.field')}
              >
                <span className={labelRowCss}>
                  {task.labels.length > 0
                    ? task.labels.map((label) => (
                        <TaskLabelBadge key={label.id} label={label} />
                      ))
                    : t('labels.none')}
                </span>
              </TaskProperty>
              <TaskProperty
                icon={<RiFileTextLine size={18} />}
                label={t('form.description')}
                alignStart
              >
                <span className={descriptionCss}>
                  {task.description || t('workspace.emptyDescription')}
                </span>
              </TaskProperty>
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

            <DetailSection title={t('subtasks.title')}>
              <TaskSubtasksSection taskId={task.id} />
            </DetailSection>
            <DetailSection title={t('comments.title')}>
              <TaskCommentsSection taskId={task.id} />
            </DetailSection>
            <details className={disclosureCss}>
              <summary>{t('attachments.title')}</summary>
              <div className={disclosureBodyCss}>
                <TaskAttachmentsSection taskId={task.id} />
              </div>
            </details>
            <details className={disclosureCss}>
              <summary>{t('history.title')}</summary>
              <div className={disclosureBodyCss}>
                <TaskHistorySection taskId={task.id} />
              </div>
            </details>
          </div>
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

const TaskProperty = ({
  icon,
  label,
  children,
  alignStart = false,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
  alignStart?: boolean
}) => (
  <div className={propertyRowCss} data-align-start={alignStart || undefined}>
    <span className={propertyIconCss} aria-hidden="true">
      {icon}
    </span>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
)

const DetailSection = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) => (
  <section className={detailSectionCss}>
    <h3>{title}</h3>
    {children}
  </section>
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
const createDialogHeaderCss = css({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& h2': {
    margin: 0,
    color: 'greyscale.900',
    fontSize: '1rem',
    fontWeight: 'bold',
  },
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
const panelBodyCss = css({ flex: 1, minHeight: 0, overflowY: 'auto' })
const detailContentCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
  padding: '1.25rem 1.25rem 1.5rem',
  fontSize: '0.875rem',
})
const taskTitleRowCss = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.75rem',
})
const titleStatusCss = css({
  width: '1.375rem',
  height: '1.375rem',
  marginTop: '0.125rem',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '999px',
  color: 'white',
  fontSize: '0.75rem',
  '&[data-complete]': {
    borderColor: 'success.500',
    backgroundColor: 'success.500',
  },
})
const taskTitleTextCss = css({
  minWidth: 0,
  flex: 1,
  '& h2': {
    margin: 0,
    color: 'greyscale.900',
    fontSize: '1.125rem',
    fontWeight: '600',
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
  },
  '& span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const descriptionCss = css({
  display: 'block',
  color: 'default.text',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const labelRowCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' })
const propertyListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  margin: 0,
})
const propertyRowCss = css({
  minHeight: '2.5rem',
  display: 'grid',
  gridTemplateColumns: '1.5rem 6.5rem minmax(0, 1fr)',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '6px',
  _hover: { backgroundColor: 'greyscale.50' },
  '&[data-align-start]': { alignItems: 'start' },
  '& dt': { color: 'greyscale.500', fontSize: '0.8125rem' },
  '& dd': {
    minWidth: 0,
    margin: 0,
    color: 'greyscale.900',
    fontSize: '0.875rem',
  },
})
const propertyIconCss = css({
  display: 'inline-flex',
  color: 'greyscale.500',
})
const sourceLinkCss = css({ color: 'primary.600', textDecoration: 'none' })
const actionsCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' })
const inlineErrorCss = css({ margin: 0, color: 'danger.subtle-text' })
const detailSectionCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  paddingTop: '1rem',
  borderTop: '1px solid token(colors.greyscale.200)',
  '& h3': {
    margin: 0,
    color: 'greyscale.900',
    fontSize: '0.875rem',
    fontWeight: '600',
  },
})
const disclosureCss = css({
  borderTop: '1px solid token(colors.greyscale.200)',
  '& summary': {
    paddingTop: '1rem',
    color: 'greyscale.900',
    fontSize: '0.875rem',
    fontWeight: '600',
    cursor: 'pointer',
  },
})
const disclosureBodyCss = css({ paddingTop: '0.75rem' })
const stateCss = css({ margin: '1rem', color: 'default.subtle-text' })
const errorCss = css({ margin: '1rem', color: 'danger.subtle-text' })
