import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiCalendarLine,
  RiEditLine,
  RiFileTextLine,
  RiFlagLine,
  RiListCheck3,
  RiUser3Line,
  RiUserAddLine,
} from '@remixicon/react'

import { ModalCloseButton } from '@/components/Modal'
import { ContactPicker, type DirectoryMember } from '@/features/contacts'
import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskList,
  PatchTaskPayload,
  TaskPriority,
} from '../api/ApiTask'
import { usePatchTask, useTask } from '../api/fetchTasks'
import { nextTaskStatuses } from '../taskUi'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskForm } from './TaskForm'
import { TaskUserDisplay } from './TaskUserDisplay'
import {
  TaskAttachmentsSection,
  TaskCommentsSection,
  TaskHistorySection,
  TaskSubtasksSection,
} from './TaskCollaborationSections'

const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent']

type EditableTaskField =
  | 'title'
  | 'startDate'
  | 'dueDate'
  | 'priority'
  | 'placement'
  | 'description'

export const CreateTaskPanel = ({
  taskLists,
  defaultTaskListId,
  defaultGroupId,
  titleInputRef,
  onClose,
  onCreated,
}: {
  taskLists: ApiTaskList[]
  defaultTaskListId?: string
  defaultGroupId?: string
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
        taskLists={taskLists}
        defaultTaskListId={defaultTaskListId}
        defaultGroupId={defaultGroupId}
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
  taskLists,
  onClose,
}: {
  taskId: string
  fallbackTask?: ApiTask
  taskLists: ApiTaskList[]
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTask(taskId)
  const task = data || fallbackTask
  const [editingField, setEditingField] = useState<EditableTaskField | null>(
    null
  )
  const [draftText, setDraftText] = useState('')
  const [draftDate, setDraftDate] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('none')
  const [draftTaskListId, setDraftTaskListId] = useState('')
  const [draftGroupId, setDraftGroupId] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const patchMutation = usePatchTask()
  const focusInput = useCallback((element: HTMLInputElement | null) => {
    element?.focus()
  }, [])
  const focusTextArea = useCallback((element: HTMLTextAreaElement | null) => {
    element?.focus()
  }, [])

  useEffect(() => {
    setEditingField(null)
    setAssigneePickerOpen(false)
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

  const beginEditing = (field: EditableTaskField) => {
    if (!task.can_edit || patchMutation.isPending) return
    setEditingField(field)
    if (field === 'title') setDraftText(task.title)
    if (field === 'description') setDraftText(task.description)
    if (field === 'startDate') setDraftDate(task.start_date || '')
    if (field === 'dueDate') setDraftDate(task.due_date || '')
    if (field === 'priority') setDraftPriority(task.priority)
    if (field === 'placement') {
      setDraftTaskListId(task.task_list?.id || '')
      setDraftGroupId(task.group?.id || '')
    }
  }

  const saveField = async (patch: PatchTaskPayload) => {
    try {
      await patchMutation.mutateAsync({ taskId: task.id, patch })
      setEditingField(null)
    } catch {
      // Keep the field open so the user can correct it or retry.
    }
  }

  const editLabel = (label: string) => `${t('actions.edit')} ${label}`
  const selectedDraftTaskList = taskLists.find(
    (taskList) => taskList.id === draftTaskListId
  )

  return (
    <PanelShell title={t('workspace.details')} onClose={onClose}>
      <div className={panelBodyCss}>
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
              {editingField === 'title' ? (
                <div className={titleEditorCss}>
                  <Input
                    ref={focusInput}
                    aria-label={t('form.title')}
                    value={draftText}
                    maxLength={500}
                    onChange={(event) => setDraftText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && draftText.trim()) {
                        event.preventDefault()
                        void saveField({ title: draftText.trim() })
                      }
                      if (event.key === 'Escape') setEditingField(null)
                    }}
                  />
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    saveDisabled={!draftText.trim()}
                    onCancel={() => setEditingField(null)}
                    onSave={() => void saveField({ title: draftText.trim() })}
                  />
                </div>
              ) : (
                <h2>
                  {task.can_edit ? (
                    <button
                      type="button"
                      className={titleEditButtonCss}
                      aria-label={editLabel(t('form.title'))}
                      disabled={patchMutation.isPending}
                      onClick={() => beginEditing('title')}
                    >
                      <span>{task.title}</span>
                      <RiEditLine size={16} aria-hidden="true" />
                    </button>
                  ) : (
                    task.title
                  )}
                </h2>
              )}
              <span>{t(`statuses.${task.status}`)}</span>
            </div>
          </div>

          {task.can_update_status && (
            <div className={actionsCss}>
              {nextTaskStatuses(task).map((status) => (
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
            </div>
          )}
          {patchMutation.error && (
            <p role="alert" className={inlineErrorCss}>
              {t('error')}
            </p>
          )}

          <dl className={propertyListCss}>
            <TaskProperty
              icon={<RiUser3Line size={18} />}
              label={t('meta.assignee')}
              editLabel={editLabel(t('meta.assignee'))}
              isDisabled={patchMutation.isPending}
              onEdit={
                task.can_edit ? () => setAssigneePickerOpen(true) : undefined
              }
            >
              <TaskUserDisplay user={task.assignee} />
            </TaskProperty>
            <TaskProperty
              icon={<RiUserAddLine size={18} />}
              label={t('meta.creator')}
            >
              <TaskUserDisplay user={task.creator} />
            </TaskProperty>
            <TaskProperty
              icon={<RiListCheck3 size={18} />}
              label={t('taskLists.field')}
              editLabel={editLabel(t('taskLists.field'))}
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'placement'}
              alignStart={editingField === 'placement'}
              onEdit={
                task.can_edit ? () => beginEditing('placement') : undefined
              }
            >
              {editingField === 'placement' ? (
                <div className={inlineEditorCss}>
                  <div className={placementEditorCss}>
                    <Select
                      label={
                        <span className="sr-only">{t('taskLists.field')}</span>
                      }
                      aria-label={t('taskLists.field')}
                      items={[
                        { value: '', label: t('taskLists.none') },
                        ...taskLists.map((taskList) => ({
                          value: taskList.id,
                          label: taskList.name,
                        })),
                      ]}
                      selectedKey={draftTaskListId}
                      onSelectionChange={(key) => {
                        setDraftTaskListId(String(key))
                        setDraftGroupId('')
                      }}
                    />
                    {selectedDraftTaskList &&
                      selectedDraftTaskList.groups.length > 0 && (
                        <Select
                          label={
                            <span className="sr-only">{t('groups.field')}</span>
                          }
                          aria-label={t('groups.field')}
                          items={[
                            { value: '', label: t('groups.ungrouped') },
                            ...selectedDraftTaskList.groups.map((group) => ({
                              value: group.id,
                              label: group.name,
                            })),
                          ]}
                          selectedKey={draftGroupId}
                          onSelectionChange={(key) =>
                            setDraftGroupId(String(key))
                          }
                        />
                      )}
                  </div>
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onSave={() =>
                      void saveField({
                        task_list_id: draftTaskListId || null,
                        group_id: draftGroupId || null,
                      })
                    }
                  />
                </div>
              ) : task.task_list ? (
                `${task.task_list.name}${task.group ? ` / ${task.group.name}` : ''}`
              ) : (
                t('taskLists.none')
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiCalendarLine size={18} />}
              label={t('meta.startDate')}
              editLabel={editLabel(t('meta.startDate'))}
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'startDate'}
              alignStart={editingField === 'startDate'}
              onEdit={
                task.can_edit ? () => beginEditing('startDate') : undefined
              }
            >
              {editingField === 'startDate' ? (
                <div className={inlineEditorCss}>
                  <Input
                    ref={focusInput}
                    type="date"
                    aria-label={t('meta.startDate')}
                    value={draftDate}
                    max={task.due_date || undefined}
                    onChange={(event) => setDraftDate(event.target.value)}
                  />
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onSave={() =>
                      void saveField({ start_date: draftDate || null })
                    }
                  />
                </div>
              ) : (
                formatDate(task.start_date)
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiCalendarLine size={18} />}
              label={t('meta.dueDate')}
              editLabel={editLabel(t('meta.dueDate'))}
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'dueDate'}
              alignStart={editingField === 'dueDate'}
              onEdit={task.can_edit ? () => beginEditing('dueDate') : undefined}
            >
              {editingField === 'dueDate' ? (
                <div className={inlineEditorCss}>
                  <Input
                    ref={focusInput}
                    type="date"
                    aria-label={t('meta.dueDate')}
                    value={draftDate}
                    min={task.start_date || undefined}
                    onChange={(event) => setDraftDate(event.target.value)}
                  />
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onSave={() =>
                      void saveField({ due_date: draftDate || null })
                    }
                  />
                </div>
              ) : (
                formatDate(task.due_date)
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiFlagLine size={18} />}
              label={t('form.priority')}
              editLabel={editLabel(t('form.priority'))}
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'priority'}
              alignStart={editingField === 'priority'}
              onEdit={
                task.can_edit ? () => beginEditing('priority') : undefined
              }
            >
              {editingField === 'priority' ? (
                <div className={inlineEditorCss}>
                  <div className={inlineSelectCss}>
                    <Select
                      label={
                        <span className="sr-only">{t('form.priority')}</span>
                      }
                      aria-label={t('form.priority')}
                      items={priorities.map((value) => ({
                        value,
                        label: t(`priorities.${value}`),
                      }))}
                      selectedKey={draftPriority}
                      onSelectionChange={(key) =>
                        setDraftPriority(String(key) as TaskPriority)
                      }
                    />
                  </div>
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onSave={() => void saveField({ priority: draftPriority })}
                  />
                </div>
              ) : (
                <TaskPriorityBadge priority={task.priority} />
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiFileTextLine size={18} />}
              label={t('form.description')}
              editLabel={editLabel(t('form.description'))}
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'description'}
              alignStart
              onEdit={
                task.can_edit ? () => beginEditing('description') : undefined
              }
            >
              {editingField === 'description' ? (
                <div className={inlineEditorCss}>
                  <TextArea
                    ref={focusTextArea}
                    aria-label={t('form.description')}
                    value={draftText}
                    maxLength={5000}
                    rows={4}
                    onChange={(event) => setDraftText(event.target.value)}
                  />
                  <InlineEditorActions
                    loading={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onSave={() =>
                      void saveField({ description: draftText.trim() })
                    }
                  />
                </div>
              ) : (
                <span className={descriptionCss}>
                  {task.description || t('workspace.emptyDescription')}
                </span>
              )}
            </TaskProperty>
          </dl>

          {assigneePickerOpen && (
            <ContactPicker
              includeSelf
              title={t('form.selectAssignee')}
              searchPlaceholder={t('form.searchAssignee')}
              onClose={() => setAssigneePickerOpen(false)}
              onSelect={(member: DirectoryMember) => {
                setAssigneePickerOpen(false)
                void saveField({ assignee_id: member.id })
              }}
            />
          )}

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
  editLabel,
  onEdit,
  isDisabled = false,
  isEditing = false,
  alignStart = false,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
  editLabel?: string
  onEdit?: () => void
  isDisabled?: boolean
  isEditing?: boolean
  alignStart?: boolean
}) => (
  <div className={propertyRowCss} data-align-start={alignStart || undefined}>
    <span className={propertyIconCss} aria-hidden="true">
      {icon}
    </span>
    <dt>{label}</dt>
    <dd>
      {onEdit && !isEditing ? (
        <button
          type="button"
          className={propertyEditButtonCss}
          aria-label={editLabel}
          disabled={isDisabled}
          onClick={onEdit}
        >
          <span>{children}</span>
          <RiEditLine size={15} aria-hidden="true" />
        </button>
      ) : (
        children
      )}
    </dd>
  </div>
)

const InlineEditorActions = ({
  loading,
  saveDisabled = false,
  onCancel,
  onSave,
}: {
  loading: boolean
  saveDisabled?: boolean
  onCancel: () => void
  onSave: () => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={inlineEditorActionsCss}>
      <Button
        type="button"
        size="dense"
        variant="secondary"
        isDisabled={loading}
        onPress={onCancel}
      >
        {t('form.cancel')}
      </Button>
      <Button
        type="button"
        size="dense"
        loading={loading}
        isDisabled={saveDisabled}
        onPress={onSave}
      >
        {t('actions.save')}
      </Button>
    </div>
  )
}

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
  '& > span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const titleEditButtonCss = css({
  width: '100%',
  minWidth: 0,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: 0,
  border: 0,
  backgroundColor: 'transparent',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  '& span': { overflowWrap: 'anywhere' },
  '& svg': {
    flexShrink: 0,
    marginTop: '0.25rem',
    color: 'greyscale.500',
    opacity: 0,
  },
  _hover: { '& svg': { opacity: 1 } },
  _focusVisible: { '& svg': { opacity: 1 } },
  _disabled: { cursor: 'default' },
})
const titleEditorCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})
const descriptionCss = css({
  display: 'block',
  color: 'default.text',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
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
const propertyEditButtonCss = css({
  width: '100%',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.25rem 0.375rem',
  border: 0,
  borderRadius: '4px',
  backgroundColor: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  '& > span': { minWidth: 0 },
  '& > svg': { flexShrink: 0, color: 'greyscale.500', opacity: 0 },
  _hover: {
    backgroundColor: 'greyscale.100',
    '& > svg': { opacity: 1 },
  },
  _focusVisible: { '& > svg': { opacity: 1 } },
  _disabled: { cursor: 'default' },
})
const inlineEditorCss = css({
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})
const inlineEditorActionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
})
const inlineSelectCss = css({ width: '100%' })
const placementEditorCss = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
  gap: '0.5rem',
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
