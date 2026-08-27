import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiCalendarLine,
  RiCalendar2Line,
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiBookmarkFill,
  RiBookmarkLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileTextLine,
  RiFlagLine,
  RiGitBranchLine,
  RiListCheck3,
  RiMoreLine,
  RiRestartLine,
  RiRepeatLine,
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
  TaskRecurrenceFrequency,
  TaskRecurrenceScope,
} from '../api/ApiTask'
import {
  useAddTaskFollowers,
  useDeleteTask,
  useFollowTask,
  usePatchTask,
  useReorderTaskSubtasks,
  useRemoveTaskFollower,
  useTask,
  useTaskParentCandidates,
  useTaskSubtasks,
  useTaskSubtreeImpact,
  useStopTaskRecurrence,
  useUnfollowTask,
  useUpdateTaskRecurrence,
} from '../api/fetchTasks'
import { formatTaskDate } from '../taskDateFormat'
import {
  incompleteDescendantCount,
  nextTaskStatuses,
  taskAssignees,
} from '../taskUi'
import { TaskAssigneePickerDialog } from './TaskAssigneePickerDialog'
import { TaskCompletionButton } from './TaskCompletionButton'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskFollowerPickerDialog } from './TaskFollowerPickerDialog'
import { TaskForm } from './TaskForm'
import { TaskShareDialog } from './TaskShareDialog'
import { TaskAssigneeAvatars, TaskUserDisplay } from './TaskUserDisplay'
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
  | 'parent'
  | 'description'

type SubtaskEditableField = 'title' | 'dueDate'

export const CreateTaskPanel = ({
  taskLists,
  defaultTaskListId,
  defaultGroupId,
  parentTask,
  titleInputRef,
  onClose,
  onCreated,
}: {
  taskLists: ApiTaskList[]
  defaultTaskListId?: string
  defaultGroupId?: string
  parentTask?: ApiTask
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
        parentTask={parentTask}
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
  onCreateSubtask,
  onOpenSubtask,
  onClose,
}: {
  taskId: string
  fallbackTask?: ApiTask
  taskLists: ApiTaskList[]
  sharedVia?: string
  onCreateSubtask: (parentTask: ApiTask) => void
  onOpenSubtask: (subtask: ApiTask) => void
  onClose: () => void
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTask(taskId, sharedVia)
  const { data: subtasks = [], isLoading: subtasksLoading } =
    useTaskSubtasks(taskId)
  const { data: subtreeImpact } = useTaskSubtreeImpact(taskId)
  const { data: parentCandidates = [] } = useTaskParentCandidates(taskId)
  const task = data || fallbackTask
  const [editingField, setEditingField] = useState<EditableTaskField | null>(
    null
  )
  const [draftText, setDraftText] = useState('')
  const [draftDate, setDraftDate] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('medium')
  const [draftTaskListId, setDraftTaskListId] = useState('')
  const [draftGroupId, setDraftGroupId] = useState('')
  const [draftParentId, setDraftParentId] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const [followerPickerOpen, setFollowerPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [recurrenceEditScope, setRecurrenceEditScope] =
    useState<TaskRecurrenceScope>('one')
  const [subtaskEditing, setSubtaskEditing] = useState<{
    taskId: string
    field: SubtaskEditableField
  } | null>(null)
  const [subtaskDraft, setSubtaskDraft] = useState('')
  const [subtaskAssigneeEditing, setSubtaskAssigneeEditing] =
    useState<ApiTask | null>(null)
  const [showSavedState, setShowSavedState] = useState(false)
  const placementEditorRef = useRef<HTMLDivElement>(null)
  const patchMutation = usePatchTask()
  const reorderSubtasksMutation = useReorderTaskSubtasks()
  const deleteMutation = useDeleteTask()
  const followMutation = useFollowTask()
  const unfollowMutation = useUnfollowTask()
  const addFollowersMutation = useAddTaskFollowers()
  const removeFollowerMutation = useRemoveTaskFollower()
  const updateRecurrenceMutation = useUpdateTaskRecurrence()
  const stopRecurrenceMutation = useStopTaskRecurrence()

  useEffect(() => {
    if (patchMutation.isPending) {
      setShowSavedState(false)
      return
    }
    if (!patchMutation.isSuccess) return
    setShowSavedState(true)
    const timeout = window.setTimeout(() => setShowSavedState(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [patchMutation.isPending, patchMutation.isSuccess])
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
    setSubtaskEditing(null)
    setSubtaskAssigneeEditing(null)
    setRecurrenceEditScope('one')
  }, [taskId])

  useEffect(() => {
    if (editingField !== 'placement') return
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (placementEditorRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[role="listbox"]'))
        return
      setEditingField(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress, true)
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePress, true)
  }, [editingField])

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
    return formatTaskDate(value, i18n.language)
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
    if (field === 'parent') setDraftParentId(task.parent_id || '')
  }

  const saveField = async (
    patch: PatchTaskPayload,
    options: { keepEditing?: boolean } = {}
  ) => {
    const recurrenceTemplateFields = new Set([
      'title',
      'description',
      'start_date',
      'due_date',
      'priority',
      'task_list_id',
      'group_id',
      'assignee_id',
      'assignee_ids',
    ])
    const affectsFollowingTemplate = Object.keys(patch).some((field) =>
      recurrenceTemplateFields.has(field)
    )
    const scopedPatch =
      task.recurrence && affectsFollowingTemplate
        ? { ...patch, recurrence_scope: recurrenceEditScope }
        : patch
    try {
      await patchMutation.mutateAsync({ taskId: task.id, patch: scopedPatch })
      if (!options.keepEditing) setEditingField(null)
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
  const openDescendantCount = incompleteDescendantCount(task)
  const followActionLabel = task.is_following
    ? t('followers.unfollow')
    : t('followers.follow')
  const deleteTask = async () => {
    const accepted = await confirm({
      title: t('actions.deleteTitle'),
      message:
        subtreeImpact && subtreeImpact.descendant_count > 0
          ? t('actions.deleteSubtreeDescription', {
              title: task.title,
              count: subtreeImpact.descendant_count,
            })
          : t('actions.deleteDescription', { title: task.title }),
      confirmLabel: t('actions.delete'),
      danger: true,
    })
    if (!accepted) return
    try {
      await deleteMutation.mutateAsync({
        taskId: task.id,
        confirmSubtreeNodeCount: subtreeImpact?.node_count,
      })
      onClose()
    } catch {
      // Keep the panel open so the mutation error remains visible.
    }
  }

  const moveTask = async (parentId: string) => {
    if ((task.parent_id || '') === parentId) {
      setEditingField(null)
      return
    }
    if (subtreeImpact && subtreeImpact.descendant_count > 0) {
      const accepted = await confirm({
        title: t('subtasks.moveTitle'),
        message: t('subtasks.moveSubtreeDescription', {
          count: subtreeImpact.node_count,
        }),
        confirmLabel: t('subtasks.move'),
      })
      if (!accepted) {
        setEditingField(null)
        return
      }
    }
    setDraftParentId(parentId)
    await saveField({
      parent_id: parentId || null,
      confirm_subtree_node_count: subtreeImpact?.node_count,
    })
  }

  const changeTaskStatus = async (
    targetTask: ApiTask,
    status: ApiTask['status']
  ) => {
    if (status === 'completed' && incompleteDescendantCount(targetTask) > 0) {
      const accepted = await confirm({
        title: t('actions.completeWithOpenSubtasksTitle'),
        message: t('actions.completeWithOpenSubtasksDescription', {
          count: incompleteDescendantCount(targetTask),
        }),
        confirmLabel: t('actions.completeAnyway'),
      })
      if (!accepted) return
    }
    try {
      await patchMutation.mutateAsync({
        taskId: targetTask.id,
        patch: { status },
      })
    } catch {
      // Keep the current state visible and let the shared error surface explain it.
    }
  }

  const toggleSubtaskStatus = (subtask: ApiTask) => {
    if (!subtask.can_update_status || patchMutation.isPending) return
    void changeTaskStatus(
      subtask,
      subtask.status === 'completed' ? 'todo' : 'completed'
    )
  }

  const beginSubtaskEdit = (subtask: ApiTask, field: SubtaskEditableField) => {
    if (!subtask.can_edit || patchMutation.isPending) return
    setSubtaskEditing({ taskId: subtask.id, field })
    setSubtaskDraft(field === 'title' ? subtask.title : subtask.due_date || '')
  }

  const saveSubtaskField = async (
    subtask: ApiTask,
    patch: PatchTaskPayload
  ) => {
    if (patchMutation.isPending) return
    const unchanged =
      (patch.title !== undefined && patch.title === subtask.title) ||
      (patch.due_date !== undefined && patch.due_date === subtask.due_date) ||
      (patch.assignee_ids !== undefined &&
        patch.assignee_ids.join(',') ===
          taskAssignees(subtask)
            .map((assignee) => assignee.id)
            .join(','))
    if (unchanged) {
      setSubtaskEditing(null)
      setSubtaskAssigneeEditing(null)
      return
    }
    try {
      await patchMutation.mutateAsync({ taskId: subtask.id, patch })
      setSubtaskEditing(null)
      setSubtaskAssigneeEditing(null)
    } catch {
      // Keep the inline editor open so the user can retry.
    }
  }

  const moveSubtask = (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset
    if (
      targetIndex < 0 ||
      targetIndex >= subtasks.length ||
      reorderSubtasksMutation.isPending
    ) {
      return
    }
    const ordered = [...subtasks]
    const [moved] = ordered.splice(index, 1)
    ordered.splice(targetIndex, 0, moved)
    reorderSubtasksMutation.mutate({
      taskId,
      taskIds: ordered.map((subtask) => subtask.id),
    })
  }

  return (
    <PanelShell
      title={t('workspace.details')}
      onClose={onClose}
      startAction={
        task.can_update_status && nextStatus ? (
          <div className={headerTaskStatusCss}>
            <span
              className={headerStatusCss}
              data-completed={task.status === 'completed' || undefined}
            >
              {task.status === 'completed' && (
                <RiCheckLine size={15} aria-hidden="true" />
              )}
              {t(`statuses.${task.status}`)}
            </span>
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
              onPress={() => void changeTaskStatus(task, nextStatus)}
            >
              {t(`actions.to_${nextStatus}`)}
            </Button>
          </div>
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
          {task.ancestor_path.length > 1 && (
            <nav
              aria-label={t('subtasks.parentChain')}
              className={breadcrumbCss}
            >
              {task.ancestor_path.slice(0, -1).map((node, index) => (
                <span key={node.id}>
                  {index > 0 && <span aria-hidden="true">›</span>}
                  <Link href={`/tasks?task=${encodeURIComponent(node.id)}`}>
                    {node.title}
                  </Link>
                </span>
              ))}
            </nav>
          )}
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
                    onBlur={() => {
                      const title = draftText.trim()
                      if (!title || title === task.title) {
                        setEditingField(null)
                        return
                      }
                      void saveField({ title })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && draftText.trim()) {
                        event.preventDefault()
                        void saveField({ title: draftText.trim() })
                      }
                      if (event.key === 'Escape') setEditingField(null)
                    }}
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
          {task.status === 'completed' && openDescendantCount > 0 && (
            <p role="status" className={completedWithOpenSubtasksCss}>
              <RiGitBranchLine size={16} aria-hidden="true" />
              {t('subtasks.completedWithOpenSubtasks', {
                count: openDescendantCount,
              })}
            </p>
          )}
          {(patchMutation.isPending || showSavedState) && (
            <p className={saveStateCss} aria-live="polite">
              {patchMutation.isPending
                ? t('saveState.saving')
                : t('saveState.saved')}
            </p>
          )}
          {(patchMutation.error ||
            deleteMutation.error ||
            followMutation.error ||
            unfollowMutation.error ||
            addFollowersMutation.error ||
            removeFollowerMutation.error ||
            updateRecurrenceMutation.error ||
            stopRecurrenceMutation.error) && (
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
            {task.recurrence && (
              <TaskProperty
                icon={<RiRepeatLine size={18} />}
                label={t('recurrence.label')}
                alignStart
              >
                <div className={recurrenceDetailCss}>
                  {task.recurrence.can_manage ? (
                    <Select
                      label={
                        <span className="sr-only">{t('recurrence.label')}</span>
                      }
                      aria-label={t('recurrence.label')}
                      items={[
                        { value: 'none', label: t('recurrence.none') },
                        { value: 'daily', label: t('recurrence.daily') },
                        { value: 'weekly', label: t('recurrence.weekly') },
                        { value: 'monthly', label: t('recurrence.monthly') },
                      ]}
                      selectedKey={
                        task.recurrence.is_active
                          ? task.recurrence.frequency
                          : 'none'
                      }
                      onSelectionChange={(key) => {
                        const frequency = String(key)
                        if (frequency === 'none') {
                          stopRecurrenceMutation.mutate(task.id)
                          return
                        }
                        updateRecurrenceMutation.mutate({
                          taskId: task.id,
                          recurrence: {
                            frequency: frequency as TaskRecurrenceFrequency,
                            interval: task.recurrence?.interval || 1,
                            end_date: task.recurrence?.end_date || null,
                            max_occurrences:
                              task.recurrence?.max_occurrences || null,
                          },
                        })
                      }}
                    />
                  ) : (
                    <span>
                      {task.recurrence.is_active
                        ? t(`recurrence.${task.recurrence.frequency}`)
                        : t('recurrence.stopped')}
                    </span>
                  )}
                  {task.recurrence.interval > 1 && (
                    <span>
                      {t('recurrence.intervalSummary', {
                        count: task.recurrence.interval,
                        unit: t(
                          `recurrence.units.${task.recurrence.frequency}`
                        ),
                      })}
                    </span>
                  )}
                  {task.recurrence.next_occurrence_date && (
                    <span>
                      {t('recurrence.next', {
                        date: formatDate(task.recurrence.next_occurrence_date),
                      })}
                    </span>
                  )}
                  {task.recurrence.is_active && task.recurrence.can_manage && (
                    <Select
                      label={
                        <span className="sr-only">
                          {t('recurrence.editScope')}
                        </span>
                      }
                      aria-label={t('recurrence.editScope')}
                      items={[
                        { value: 'one', label: t('recurrence.onlyThis') },
                        {
                          value: 'following',
                          label: t('recurrence.thisAndFollowing'),
                        },
                      ]}
                      selectedKey={recurrenceEditScope}
                      onSelectionChange={(key) =>
                        setRecurrenceEditScope(
                          String(key) as TaskRecurrenceScope
                        )
                      }
                    />
                  )}
                </div>
              </TaskProperty>
            )}
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
              control="select"
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'placement'}
              alignStart={editingField === 'placement'}
              onEdit={
                task.can_edit ? () => beginEditing('placement') : undefined
              }
            >
              {editingField === 'placement' ? (
                <div ref={placementEditorRef} className={inlineEditorCss}>
                  <div
                    className={placementEditorCss}
                    data-has-group={
                      selectedDraftTaskList?.groups.length ? true : undefined
                    }
                  >
                    <DetailInlineSelect
                      label={t('taskLists.field')}
                      items={[
                        { value: '', label: t('taskLists.standalone') },
                        ...taskLists.map((taskList) => ({
                          value: taskList.id,
                          label: taskList.name,
                        })),
                      ]}
                      value={draftTaskListId}
                      disabled={patchMutation.isPending}
                      onCancel={() => {
                        if (!selectedDraftTaskList?.groups.length) {
                          setEditingField(null)
                        }
                      }}
                      onChange={(taskListId) => {
                        const taskList = taskLists.find(
                          (item) => item.id === taskListId
                        )
                        setDraftTaskListId(taskListId)
                        setDraftGroupId('')
                        void saveField(
                          {
                            task_list_id: taskListId || null,
                            group_id: null,
                          },
                          { keepEditing: Boolean(taskList?.groups.length) }
                        )
                      }}
                    />
                    {selectedDraftTaskList &&
                      selectedDraftTaskList.groups.length > 0 && (
                        <DetailInlineSelect
                          label={t('groups.field')}
                          autoOpen={false}
                          items={[
                            { value: '', label: t('groups.ungrouped') },
                            ...selectedDraftTaskList.groups.map((group) => ({
                              value: group.id,
                              label: group.name,
                            })),
                          ]}
                          value={draftGroupId}
                          disabled={patchMutation.isPending}
                          onCancel={() => setEditingField(null)}
                          onChange={(groupId) => {
                            setDraftGroupId(groupId)
                            void saveField({
                              task_list_id: draftTaskListId,
                              group_id: groupId || null,
                            })
                          }}
                        />
                      )}
                  </div>
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
              control="date"
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'startDate'}
              alignStart={editingField === 'startDate'}
              onEdit={
                task.can_edit ? () => beginEditing('startDate') : undefined
              }
            >
              {editingField === 'startDate' ? (
                <div className={inlineEditorCss}>
                  <DetailInlineDateEditor
                    label={t('meta.startDate')}
                    value={draftDate}
                    max={task.due_date || undefined}
                    pending={patchMutation.isPending}
                    onChange={setDraftDate}
                    onSave={(startDate) =>
                      void saveField({ start_date: startDate || null })
                    }
                    onCancel={() => setEditingField(null)}
                  />
                </div>
              ) : (
                formatDate(task.start_date)
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiGitBranchLine size={18} />}
              label={t('subtasks.parent')}
              editLabel={editLabel(t('subtasks.parent'))}
              control="select"
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'parent'}
              alignStart={editingField === 'parent'}
              onEdit={task.can_edit ? () => beginEditing('parent') : undefined}
            >
              {editingField === 'parent' ? (
                <div className={inlineEditorCss}>
                  <DetailInlineSelect
                    label={t('subtasks.parent')}
                    items={[
                      { value: '', label: t('subtasks.rootTask') },
                      ...parentCandidates.map((candidate) => ({
                        value: candidate.id,
                        label:
                          `${'—'.repeat(candidate.depth)} ${candidate.title}`.trim(),
                      })),
                    ]}
                    value={draftParentId}
                    disabled={patchMutation.isPending}
                    onCancel={() => setEditingField(null)}
                    onChange={(parentId) => void moveTask(parentId)}
                  />
                </div>
              ) : task.parent_id ? (
                task.ancestor_path.at(-2)?.title || t('subtasks.parent')
              ) : (
                t('subtasks.rootTask')
              )}
            </TaskProperty>
            <TaskProperty
              icon={<RiCalendarLine size={18} />}
              label={t('meta.dueDate')}
              editLabel={editLabel(t('meta.dueDate'))}
              control="date"
              isDisabled={patchMutation.isPending}
              isEditing={editingField === 'dueDate'}
              alignStart={editingField === 'dueDate'}
              onEdit={task.can_edit ? () => beginEditing('dueDate') : undefined}
            >
              {editingField === 'dueDate' ? (
                <div className={inlineEditorCss}>
                  <DetailInlineDateEditor
                    label={t('meta.dueDate')}
                    value={draftDate}
                    min={task.start_date || undefined}
                    pending={patchMutation.isPending}
                    onChange={setDraftDate}
                    onSave={(dueDate) =>
                      void saveField({ due_date: dueDate || null })
                    }
                    onCancel={() => setEditingField(null)}
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
              control="select"
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
                    <DetailInlineSelect
                      label={t('form.priority')}
                      items={priorities.map((value) => ({
                        value,
                        label: t(`priorities.${value}`),
                      }))}
                      value={draftPriority}
                      disabled={patchMutation.isPending}
                      onCancel={() => setEditingField(null)}
                      onChange={(value) => {
                        const priority = value as TaskPriority
                        setDraftPriority(priority)
                        void saveField({ priority })
                      }}
                    />
                  </div>
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
                    onBlur={() => {
                      const description = draftText.trim()
                      if (description === task.description) {
                        setEditingField(null)
                        return
                      }
                      void saveField({ description })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingField(null)
                    }}
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
          {subtaskAssigneeEditing && (
            <TaskAssigneePickerDialog
              initial={taskAssignees(subtaskAssigneeEditing)}
              onClose={() => setSubtaskAssigneeEditing(null)}
              onConfirm={(assignees) => {
                const subtask = subtaskAssigneeEditing
                setSubtaskAssigneeEditing(null)
                void saveSubtaskField(subtask, {
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

          <DetailSection title={t('subtasks.title')}>
            <div className={subtasksSectionCss}>
              {task.descendant_progress.total > 0 && (
                <div className={subtaskProgressCss}>
                  <RiGitBranchLine size={16} aria-hidden="true" />
                  <span
                    aria-label={t('subtasks.progress', {
                      completed: task.descendant_progress.completed,
                      total: task.descendant_progress.total,
                    })}
                  >
                    {t('subtasks.progressSummary', {
                      completed: task.descendant_progress.completed,
                      total: task.descendant_progress.total,
                    })}
                  </span>
                  <progress
                    aria-label={t('subtasks.progressLabel')}
                    value={task.descendant_progress.completed}
                    max={task.descendant_progress.total}
                  />
                </div>
              )}
              {subtasksLoading ? (
                <p className={subtaskEmptyCss}>{t('subtasks.loading')}</p>
              ) : subtasks.length > 0 ? (
                <ul className={subtaskListCss}>
                  {subtasks.map((subtask, index) => (
                    <li key={subtask.id}>
                      <TaskCompletionButton
                        task={subtask}
                        status={subtask.status}
                        pending={
                          patchMutation.isPending &&
                          patchMutation.variables?.taskId === subtask.id
                        }
                        onToggle={() => toggleSubtaskStatus(subtask)}
                      />
                      {subtaskEditing?.taskId === subtask.id &&
                      subtaskEditing.field === 'title' ? (
                        <Input
                          ref={focusInput}
                          className={subtaskTitleInputCss}
                          aria-label={t('form.title')}
                          value={subtaskDraft}
                          maxLength={500}
                          disabled={patchMutation.isPending}
                          onChange={(event) =>
                            setSubtaskDraft(event.target.value)
                          }
                          onBlur={() => {
                            const title = subtaskDraft.trim()
                            if (!title) {
                              setSubtaskEditing(null)
                              return
                            }
                            void saveSubtaskField(subtask, { title })
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              event.currentTarget.blur()
                            }
                            if (event.key === 'Escape') {
                              setSubtaskEditing(null)
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className={subtaskTitleCss}
                          data-completed={
                            subtask.status === 'completed' || undefined
                          }
                          aria-label={`${t('actions.edit')} ${t('form.title')}`}
                          disabled={
                            !subtask.can_edit || patchMutation.isPending
                          }
                          onClick={() => beginSubtaskEdit(subtask, 'title')}
                        >
                          {subtask.title}
                        </button>
                      )}
                      {subtaskEditing?.taskId === subtask.id &&
                      subtaskEditing.field === 'dueDate' ? (
                        <Input
                          ref={focusInput}
                          className={subtaskDateInputCss}
                          type="date"
                          aria-label={t('meta.dueDate')}
                          value={subtaskDraft}
                          min={subtask.start_date || undefined}
                          disabled={patchMutation.isPending}
                          onChange={(event) =>
                            setSubtaskDraft(event.target.value)
                          }
                          onBlur={() =>
                            void saveSubtaskField(subtask, {
                              due_date: subtaskDraft || null,
                            })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              event.currentTarget.blur()
                            }
                            if (event.key === 'Escape') {
                              setSubtaskEditing(null)
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className={subtaskDueDateCss}
                          aria-label={`${t('actions.edit')} ${t('meta.dueDate')}`}
                          disabled={
                            !subtask.can_edit || patchMutation.isPending
                          }
                          onClick={() => beginSubtaskEdit(subtask, 'dueDate')}
                        >
                          <RiCalendar2Line size={14} aria-hidden="true" />
                          {subtask.due_date
                            ? formatDate(subtask.due_date)
                            : t('meta.none')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={subtaskAssigneesCss}
                        aria-label={`${t('actions.edit')} ${t('meta.assignee')}`}
                        disabled={!subtask.can_edit || patchMutation.isPending}
                        onClick={() => setSubtaskAssigneeEditing(subtask)}
                      >
                        <TaskAssigneeAvatars
                          users={taskAssignees(subtask)}
                          size="1.25rem"
                        />
                      </button>
                      <span className={subtaskOrderActionsCss}>
                        <button
                          type="button"
                          aria-label={t('subtasks.moveUp', {
                            title: subtask.title,
                          })}
                          disabled={
                            index === 0 ||
                            !task.can_edit ||
                            !subtasks.every((item) => item.can_edit) ||
                            reorderSubtasksMutation.isPending
                          }
                          onClick={() => moveSubtask(index, -1)}
                        >
                          <RiArrowUpSLine size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('subtasks.moveDown', {
                            title: subtask.title,
                          })}
                          disabled={
                            index === subtasks.length - 1 ||
                            !task.can_edit ||
                            !subtasks.every((item) => item.can_edit) ||
                            reorderSubtasksMutation.isPending
                          }
                          onClick={() => moveSubtask(index, 1)}
                        >
                          <RiArrowDownSLine size={16} aria-hidden="true" />
                        </button>
                      </span>
                      <Button
                        type="button"
                        size="icon28"
                        variant="quaternaryText"
                        aria-label={t('workspace.openTask', {
                          title: subtask.title,
                        })}
                        tooltip={t('workspace.openTask', {
                          title: subtask.title,
                        })}
                        onPress={() => onOpenSubtask(subtask)}
                      >
                        <RiArrowRightSLine size={17} aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {task.can_create_subtasks && (
                <Button
                  type="button"
                  size="dense"
                  variant="quaternaryText"
                  icon={<RiAddLine size={16} aria-hidden="true" />}
                  onPress={() => onCreateSubtask(task)}
                >
                  {t('subtasks.addAction')}
                </Button>
              )}
              {!task.can_create_subtasks && (
                <p className={subtaskEmptyCss}>
                  <RiGitBranchLine size={15} aria-hidden="true" />{' '}
                  {t('subtasks.limitReached')}
                </p>
              )}
            </div>
          </DetailSection>

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
  control = 'text',
  onEdit,
  isDisabled = false,
  isEditing = false,
  alignStart = false,
}: {
  icon: ReactNode
  label: string
  children: ReactNode
  editLabel?: string
  control?: 'text' | 'select' | 'date'
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
          data-control={control}
          aria-label={editLabel}
          disabled={isDisabled}
          onClick={onEdit}
        >
          <span>{children}</span>
          {control === 'select' ? (
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          ) : control === 'date' ? (
            <RiCalendar2Line size={14} aria-hidden="true" />
          ) : (
            <RiEditLine size={15} aria-hidden="true" />
          )}
        </button>
      ) : (
        children
      )}
    </dd>
  </div>
)

const DetailInlineSelect = ({
  label,
  value,
  disabled,
  autoOpen = true,
  items,
  onChange,
  onCancel,
}: {
  label: string
  value: string
  disabled: boolean
  autoOpen?: boolean
  items: Array<{ value: string; label: ReactNode }>
  onChange: (value: string) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectionCommitted = useRef(false)
  const [isOpen, setIsOpen] = useState(autoOpen)

  useEffect(() => {
    if (autoOpen) triggerRef.current?.focus()
  }, [autoOpen])

  return (
    <Select
      aria-label={`${t('actions.edit')} ${label}`}
      className={detailInlineSelectCss}
      triggerRef={triggerRef}
      items={items}
      selectedKey={value}
      isDisabled={disabled}
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (!open) {
          window.setTimeout(() => {
            if (!selectionCommitted.current) onCancel()
          })
        }
      }}
      onSelectionChange={(key) => {
        selectionCommitted.current = true
        onChange(String(key))
      }}
    />
  )
}

const DetailInlineDateEditor = ({
  label,
  value,
  min,
  max,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  label: string
  value: string
  min?: string
  max?: string
  pending: boolean
  onChange: (value: string) => void
  onSave: (value: string) => void
  onCancel: () => void
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  return (
    <input
      ref={inputRef}
      type="date"
      className={detailInlineInputCss}
      aria-label={label}
      value={value}
      min={min}
      max={max}
      disabled={pending}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => onSave(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
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
const headerTaskStatusCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})
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
  gap: '1rem',
  padding: '1.25rem 1.25rem 1.5rem',
  fontSize: '0.875rem',
})
const taskTitleRowCss = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.75rem',
})
const completedWithOpenSubtasksCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: 0,
  padding: '0.625rem 0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.50',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
})
const saveStateCss = css({
  margin: '-0.5rem 0 0',
  color: 'greyscale.500',
  fontSize: '0.75rem',
})
const breadcrumbCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.375rem',
  color: 'greyscale.500',
  fontSize: '0.75rem',
  '& span': { display: 'inline-flex', gap: '0.375rem' },
  '& a': { color: 'primary.600', textDecoration: 'none' },
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
const recurrenceDetailCss = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
  color: 'greyscale.600',
})
const subtasksSectionCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})
const subtaskProgressCss = css({
  minHeight: '1.75rem',
  display: 'grid',
  gridTemplateColumns: 'auto auto minmax(3rem, 1fr)',
  alignItems: 'center',
  gap: '0.5rem',
  color: 'default.subtle-text',
  fontSize: '0.8125rem',
  '& progress': { width: '4rem', height: '0.3rem' },
})
const subtaskListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  '& li': {
    minHeight: '2rem',
    display: 'grid',
    gridTemplateColumns: '1rem minmax(5rem, 1fr) auto auto 3.5rem 1.75rem',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '6px',
    _hover: { backgroundColor: 'greyscale.50' },
  },
})
const subtaskTitleCss = css({
  minWidth: 0,
  overflow: 'hidden',
  padding: 0,
  border: 0,
  backgroundColor: 'transparent',
  color: 'default.text',
  fontSize: '0.8125rem',
  textAlign: 'left',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  '&[data-completed]': {
    color: 'default.subtle-text',
    textDecoration: 'line-through',
  },
  _disabled: { cursor: 'default', opacity: 1 },
})
const subtaskDueDateCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.125rem 0.25rem',
  border: 0,
  borderRadius: '4px',
  backgroundColor: 'transparent',
  color: 'greyscale.500',
  fontSize: '0.6875rem',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
  _disabled: { cursor: 'default', opacity: 1 },
})
const subtaskAssigneesCss = css({
  minWidth: '1.25rem',
  display: 'inline-flex',
  justifyContent: 'flex-end',
  padding: 0,
  border: 0,
  borderRadius: '999px',
  backgroundColor: 'transparent',
  cursor: 'pointer',
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '2px',
  },
  _disabled: { cursor: 'default', opacity: 1 },
})
const subtaskOrderActionsCss = css({
  width: '3.5rem',
  display: 'flex',
  opacity: 0.45,
  transition: 'opacity token(durations.fast)',
  '& button': {
    width: '1.75rem',
    height: '1.75rem',
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: '3px',
    backgroundColor: 'transparent',
    color: 'greyscale.500',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.100' },
    _focusVisible: {
      outline: '2px solid token(colors.primary.500)',
      outlineOffset: '-2px',
    },
    _disabled: { cursor: 'default', opacity: 0.2 },
  },
  _hover: { opacity: 1 },
  _focusWithin: { opacity: 1 },
})
const subtaskTitleInputCss = css({
  minWidth: 0,
  height: '1.75rem',
  minHeight: '1.75rem',
  fontSize: '0.8125rem',
})
const subtaskDateInputCss = css({
  width: '8.25rem',
  height: '1.75rem',
  minHeight: '1.75rem',
  fontSize: '0.6875rem',
})
const subtaskEmptyCss = css({
  margin: 0,
  color: 'default.subtle-text',
  fontSize: '0.8125rem',
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
  '&[data-control="select"], &[data-control="date"]': {
    minHeight: '1.75rem',
    margin: '-0.25rem',
    padding: '0.25rem',
    border: '1px solid transparent',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  '&[data-control="select"]:hover, &[data-control="select"]:focus-visible, &[data-control="date"]:hover, &[data-control="date"]:focus-visible':
    {
      borderColor: 'greyscale.300',
      backgroundColor: 'greyscale.000',
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
const inlineSelectCss = css({ width: '100%' })
const detailInlineInputCss = css({
  width: '100%',
  minWidth: 0,
  height: '1.75rem',
  paddingX: '0.375rem',
  border: '1px solid token(colors.primary.500)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  font: 'inherit',
  outline: 'none',
  boxShadow: '0 0 0 1px token(colors.primary.200)',
  boxSizing: 'border-box',
  marginY: '-0.25rem',
  '&:disabled': { cursor: 'wait', opacity: 0.7 },
})
const detailInlineSelectCss = css({
  width: '100%',
  minWidth: 0,
  marginY: '-0.25rem',
  '& button': {
    height: '1.75rem!',
    minHeight: '1.75rem!',
    fontSize: '0.8125rem',
  },
})
const placementEditorCss = css({
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: '0.5rem',
  '&[data-has-group]': {
    gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
  },
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
