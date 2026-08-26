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
  RiBookmarkFill,
  RiBookmarkLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileTextLine,
  RiFlagLine,
  RiListCheck3,
  RiMoreLine,
  RiRestartLine,
  RiShareForwardLine,
  RiUser3Line,
  RiUserAddLine,
  RiUserFollowLine,
} from '@remixicon/react'

import { ModalCloseButton } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import { Button, Input, Menu, MenuList, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskList,
  PatchTaskPayload,
  TaskPriority,
} from '../api/ApiTask'
import {
  useAddTaskFollowers,
  useDeleteTask,
  useFollowTask,
  usePatchTask,
  useRemoveTaskFollower,
  useTask,
  useUnfollowTask,
} from '../api/fetchTasks'
import { nextTaskStatuses, taskAssignees } from '../taskUi'
import { TaskAssigneePickerDialog } from './TaskAssigneePickerDialog'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskFollowerPickerDialog } from './TaskFollowerPickerDialog'
import { TaskForm } from './TaskForm'
import { TaskShareDialog } from './TaskShareDialog'
import { TaskUserDisplay } from './TaskUserDisplay'
import {
  TaskAttachmentsSection,
  TaskCommentsSection,
  TaskHistorySection,
} from './TaskCollaborationSections'

const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

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
  sharedVia,
  onClose,
}: {
  taskId: string
  fallbackTask?: ApiTask
  taskLists: ApiTaskList[]
  sharedVia?: string
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTask(taskId, sharedVia)
  const task = data || fallbackTask
  const [editingField, setEditingField] = useState<EditableTaskField | null>(
    null
  )
  const [draftText, setDraftText] = useState('')
  const [draftDate, setDraftDate] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('medium')
  const [draftTaskListId, setDraftTaskListId] = useState('')
  const [draftGroupId, setDraftGroupId] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const [followerPickerOpen, setFollowerPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const patchMutation = usePatchTask()
  const deleteMutation = useDeleteTask()
  const followMutation = useFollowTask()
  const unfollowMutation = useUnfollowTask()
  const addFollowersMutation = useAddTaskFollowers()
  const removeFollowerMutation = useRemoveTaskFollower()
  const { confirm } = useConfirm()
  const focusInput = useCallback((element: HTMLInputElement | null) => {
    element?.focus()
  }, [])
  const focusTextArea = useCallback((element: HTMLTextAreaElement | null) => {
    element?.focus()
  }, [])

  useEffect(() => {
    setEditingField(null)
    setAssigneePickerOpen(false)
    setFollowerPickerOpen(false)
    setShareOpen(false)
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
    if (field === 'priority') {
      setDraftPriority(task.priority === 'none' ? 'medium' : task.priority)
    }
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
  const currentAssignees = taskAssignees(task)
  const nextStatus = nextTaskStatuses(task)[0]
  const followActionLabel = task.is_following
    ? t('followers.unfollow')
    : t('followers.follow')
  const deleteTask = async () => {
    const accepted = await confirm({
      title: t('actions.deleteTitle'),
      message: t('actions.deleteDescription', { title: task.title }),
      confirmLabel: t('actions.delete'),
      danger: true,
    })
    if (!accepted) return
    try {
      await deleteMutation.mutateAsync(task.id)
      onClose()
    } catch {
      // Keep the panel open so the mutation error remains visible.
    }
  }

  return (
    <PanelShell
      title={t('workspace.details')}
      onClose={onClose}
      startAction={
        task.can_update_status && nextStatus ? (
          <Button
            size="dense"
            variant="secondary"
            icon={
              nextStatus === 'completed' ? (
                <RiCheckLine size={16} aria-hidden="true" />
              ) : (
                <RiRestartLine size={16} aria-hidden="true" />
              )
            }
            isDisabled={patchMutation.isPending || deleteMutation.isPending}
            onPress={() =>
              patchMutation.mutate({
                taskId: task.id,
                patch: { status: nextStatus },
              })
            }
          >
            {t(`actions.to_${nextStatus}`)}
          </Button>
        ) : (
          <span
            className={headerStatusCss}
            data-completed={task.status === 'completed' || undefined}
          >
            {task.status === 'completed' && (
              <RiCheckLine size={15} aria-hidden="true" />
            )}
            {t(`statuses.${task.status}`)}
          </span>
        )
      }
      actions={
        <>
          <Button
            size="icon28"
            variant="quaternaryText"
            aria-label={t('share.action')}
            tooltip={t('share.action')}
            onPress={() => setShareOpen(true)}
          >
            <RiShareForwardLine size={18} aria-hidden="true" />
          </Button>
          <Button
            size="icon28"
            variant="quaternaryText"
            aria-label={followActionLabel}
            tooltip={followActionLabel}
            isDisabled={followMutation.isPending || unfollowMutation.isPending}
            onPress={() =>
              task.is_following
                ? unfollowMutation.mutate(
                    sharedVia ? { taskId: task.id, sharedVia } : task.id
                  )
                : followMutation.mutate(
                    sharedVia ? { taskId: task.id, sharedVia } : task.id
                  )
            }
          >
            {task.is_following ? (
              <RiBookmarkFill size={18} aria-hidden="true" />
            ) : (
              <RiBookmarkLine size={18} aria-hidden="true" />
            )}
          </Button>
          {task.can_delete && (
            <Menu placement="bottom">
              <Button
                size="icon28"
                variant="quaternaryText"
                aria-label={t('actions.more')}
                isDisabled={patchMutation.isPending || deleteMutation.isPending}
              >
                <RiMoreLine size={18} aria-hidden="true" />
              </Button>
              <MenuList
                aria-label={t('actions.more')}
                menuClassName={headerMenuCss}
                items={[
                  {
                    value: 'delete',
                    label: (
                      <span className={headerMenuItemCss}>
                        <RiDeleteBinLine size={16} aria-hidden="true" />
                        {t('actions.delete')}
                      </span>
                    ),
                  },
                ]}
                onAction={(action) => {
                  if (action === 'delete') void deleteTask()
                }}
              />
            </Menu>
          )}
        </>
      }
    >
      <div className={panelBodyCss}>
        <div className={detailContentCss}>
          <div className={taskTitleRowCss}>
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
            </div>
          </div>
          {(patchMutation.error ||
            deleteMutation.error ||
            followMutation.error ||
            unfollowMutation.error ||
            addFollowersMutation.error ||
            removeFollowerMutation.error) && (
            <p role="alert" className={inlineErrorCss}>
              {t('error')}
            </p>
          )}

          <dl className={propertyListCss}>
            <TaskProperty
              icon={<RiUser3Line size={18} />}
              label={t('meta.assignee')}
              alignStart
            >
              <div className={detailMembersCss}>
                {currentAssignees.map((assignee) => (
                  <span key={assignee.id} className={detailMemberChipCss}>
                    <TaskUserDisplay user={assignee} />
                    {task.can_edit && currentAssignees.length > 1 && (
                      <button
                        type="button"
                        aria-label={t('assignees.remove', {
                          name:
                            assignee.full_name ||
                            assignee.short_name ||
                            assignee.email ||
                            '',
                        })}
                        disabled={patchMutation.isPending}
                        onClick={() =>
                          void saveField({
                            assignee_ids: currentAssignees
                              .filter((item) => item.id !== assignee.id)
                              .map((item) => item.id),
                          })
                        }
                      >
                        <RiCloseLine size={14} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ))}
                {task.can_edit && currentAssignees.length < 10 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="quaternaryText"
                    isDisabled={patchMutation.isPending}
                    onPress={() => setAssigneePickerOpen(true)}
                  >
                    {t('assignees.add')}
                  </Button>
                )}
              </div>
            </TaskProperty>
            <TaskProperty
              icon={<RiUserAddLine size={18} />}
              label={t('meta.creator')}
            >
              <TaskUserDisplay user={task.creator} />
            </TaskProperty>
            <TaskProperty
              icon={<RiUserFollowLine size={18} />}
              label={t('followers.title')}
              alignStart
            >
              <div className={detailMembersCss}>
                {task.followers.map((follower) => (
                  <span key={follower.id} className={detailMemberChipCss}>
                    <TaskUserDisplay user={follower} />
                    {task.can_manage_followers && (
                      <button
                        type="button"
                        aria-label={t('followers.remove', {
                          name:
                            follower.full_name ||
                            follower.short_name ||
                            follower.email ||
                            '',
                        })}
                        disabled={removeFollowerMutation.isPending}
                        onClick={() =>
                          removeFollowerMutation.mutate({
                            taskId: task.id,
                            followerId: follower.id,
                          })
                        }
                      >
                        <RiCloseLine size={14} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ))}
                {task.can_manage_followers && (
                  <Button
                    type="button"
                    size="sm"
                    variant="quaternaryText"
                    isDisabled={addFollowersMutation.isPending}
                    onPress={() => setFollowerPickerOpen(true)}
                  >
                    {t('followers.add')}
                  </Button>
                )}
              </div>
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
                        { value: '', label: t('taskLists.standalone') },
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
                t('taskLists.standalone')
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
            <TaskAssigneePickerDialog
              initial={taskAssignees(task)}
              onClose={() => setAssigneePickerOpen(false)}
              onConfirm={(assignees) => {
                setAssigneePickerOpen(false)
                void saveField({
                  assignee_ids: assignees.map((assignee) => assignee.id),
                })
              }}
            />
          )}
          {followerPickerOpen && (
            <TaskFollowerPickerDialog
              initial={[]}
              excludeIds={
                new Set(task.followers.map((follower) => follower.id))
              }
              onClose={() => setFollowerPickerOpen(false)}
              onConfirm={(followers) => {
                setFollowerPickerOpen(false)
                if (followers.length === 0) return
                addFollowersMutation.mutate({
                  taskId: task.id,
                  followerIds: followers.map((follower) => follower.id),
                })
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

          <DetailSection title={t('comments.title')}>
            <TaskCommentsSection
              taskId={task.id}
              sharedVia={sharedVia}
              readOnly={!task.can_comment}
            />
          </DetailSection>
          <details className={disclosureCss}>
            <summary>{t('attachments.title')}</summary>
            <div className={disclosureBodyCss}>
              <TaskAttachmentsSection
                taskId={task.id}
                sharedVia={sharedVia}
                readOnly={!task.can_manage_attachments}
              />
            </div>
          </details>
          <details className={disclosureCss}>
            <summary>{t('history.title')}</summary>
            <div className={disclosureBodyCss}>
              <TaskHistorySection taskId={task.id} sharedVia={sharedVia} />
            </div>
          </details>
        </div>
      </div>
      {shareOpen && (
        <TaskShareDialog
          task={task}
          sharedVia={sharedVia}
          onClose={() => setShareOpen(false)}
        />
      )}
    </PanelShell>
  )
}

const PanelShell = ({
  title,
  onClose,
  startAction,
  actions,
  children,
}: {
  title: string
  onClose: () => void
  startAction?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) => {
  const { t } = useTranslation('tasks')
  return (
    <aside aria-label={title} className={panelCss}>
      <header className={panelHeaderCss}>
        <div className={panelHeaderStartCss}>
          {startAction || <h2 className={panelTitleCss}>{title}</h2>}
        </div>
        <div className={panelHeaderActionsCss}>
          {actions}
          <Button
            size="icon28"
            variant="quaternaryText"
            aria-label={t('workspace.closePanel')}
            onPress={onClose}
          >
            <RiCloseLine size={19} aria-hidden="true" />
          </Button>
        </div>
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
  minHeight: '3.25rem',
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const panelHeaderStartCss = css({ minWidth: 0 })
const panelHeaderActionsCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
})
const headerStatusCss = css({
  minHeight: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  paddingX: '0.625rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '6px',
  color: 'default.subtle-text',
  fontSize: '0.8125rem',
  '&[data-completed]': {
    borderColor: 'success.200',
    color: 'success.700',
  },
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
  paddingY: '0.25rem',
  paddingX: 0,
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
const detailMembersCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.375rem',
})
const detailMemberChipCss = css({
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingY: '0.25rem',
  paddingLeft: '0.375rem',
  paddingRight: '0.25rem',
  borderRadius: '999px',
  backgroundColor: 'greyscale.100',
  '& button': {
    display: 'inline-flex',
    padding: '0.125rem',
    border: 0,
    borderRadius: '999px',
    backgroundColor: 'transparent',
    color: 'greyscale.500',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.200' },
    _disabled: { cursor: 'default', opacity: 0.5 },
  },
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
const headerMenuItemCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  color: 'danger.600',
})
const headerMenuCss = css({
  minWidth: '10rem',
  fontSize: '0.875rem',
})
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
