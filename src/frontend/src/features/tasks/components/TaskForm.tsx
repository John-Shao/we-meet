import { useState, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCalendarLine,
  RiCloseLine,
  RiFileTextLine,
  RiFlagLine,
  RiListCheck3,
  RiNotification3Line,
  RiRepeatLine,
  RiUser3Line,
  RiUserFollowLine,
} from '@remixicon/react'

import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { useUser } from '@/features/auth'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskGroup,
  ApiTaskList,
  ApiTaskUser,
  TaskPriority,
  TaskRecurrenceFrequency,
  TaskReminderMinutes,
} from '../api/ApiTask'
import { useCreateTask } from '../api/fetchTasks'
import { taskAssignees } from '../taskUi'
import { TaskAssigneePickerDialog } from './TaskAssigneePickerDialog'
import { TaskFollowerPickerDialog } from './TaskFollowerPickerDialog'
import { TaskReminderFields } from './TaskReminderControl'
import { TaskUserDisplay } from './TaskUserDisplay'

const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

export const TaskForm = ({
  taskLists,
  taskGroups = [],
  defaultTaskListId,
  defaultGroupId,
  parentTask,
  titleInputRef,
  onCancel,
  onSaved,
}: {
  taskLists: ApiTaskList[]
  taskGroups?: ApiTaskGroup[]
  defaultTaskListId?: string
  defaultGroupId?: string
  parentTask?: ApiTask
  titleInputRef?: RefObject<HTMLInputElement>
  onCancel: () => void
  onSaved: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  const { user: currentUser } = useUser()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState(parentTask?.description || '')
  const [selectedAssignees, setSelectedAssignees] = useState<
    ApiTaskUser[] | null
  >(() => (parentTask ? [...taskAssignees(parentTask)] : null))
  const [followers, setFollowers] = useState<ApiTaskUser[]>(() => [
    ...(parentTask?.followers || []),
  ])
  const [priority, setPriority] = useState<TaskPriority>(
    parentTask?.priority || 'medium'
  )
  const [taskListId, setTaskListId] = useState(
    parentTask?.task_list?.id || defaultTaskListId || ''
  )
  const [groupId, setGroupId] = useState(
    parentTask?.group?.id || defaultGroupId || ''
  )
  const [startDate, setStartDate] = useState(parentTask?.start_date || '')
  const [dueDate, setDueDate] = useState(parentTask?.due_date || '')
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<
    TaskRecurrenceFrequency | ''
  >('')
  const [recurrenceInterval, setRecurrenceInterval] = useState(1)
  const [recurrenceEnd, setRecurrenceEnd] = useState<
    'never' | 'date' | 'count'
  >('never')
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('')
  const [recurrenceCount, setRecurrenceCount] = useState(10)
  const [reminderEnabledOverride, setReminderEnabledOverride] = useState<
    boolean | null
  >(null)
  const [reminderMinutes, setReminderMinutes] =
    useState<TaskReminderMinutes | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [followerPickerOpen, setFollowerPickerOpen] = useState(false)
  const createMutation = useCreateTask()
  const today = dateInputValue(new Date())
  const tomorrowDate = new Date()
  tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrow = dateInputValue(tomorrowDate)
  const assignees =
    selectedAssignees ||
    (currentUser
      ? [
          {
            id: currentUser.id,
            full_name: currentUser.full_name,
            short_name: null,
            email: currentUser.email,
            avatar_url: currentUser.avatar_url || '',
          },
        ]
      : [])
  const reminderEnabled =
    reminderEnabledOverride ??
    Boolean(currentUser && assignees.some(({ id }) => id === currentUser.id))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (createMutation.isPending) return
    const cleanTitle = title.trim()
    if (!cleanTitle) return
    if (recurrenceFrequency && recurrenceEnd === 'date' && !recurrenceEndDate)
      return
    try {
      const payload = {
        title: cleanTitle,
        description: description.trim(),
        assignee_ids:
          assignees.length > 0
            ? assignees.map((assignee) => assignee.id)
            : undefined,
        follower_ids: followers.map((follower) => follower.id),
        priority,
        task_list_id: taskListId || null,
        group_id: groupId || null,
        start_date: startDate || null,
        due_date: dueDate || null,
        parent_id: parentTask?.id,
        ...(recurrenceFrequency
          ? {
              recurrence: {
                frequency: recurrenceFrequency,
                interval: recurrenceInterval,
                end_date:
                  recurrenceEnd === 'date' ? recurrenceEndDate || null : null,
                max_occurrences:
                  recurrenceEnd === 'count' ? recurrenceCount : null,
              },
            }
          : {}),
        reminder: {
          enabled: reminderEnabled,
          reminder_minutes: reminderMinutes,
        },
      }
      const saved = await createMutation.mutateAsync(payload)
      onSaved(saved)
    } catch {
      // Preserve the draft so the user can correct it or retry.
    }
  }

  const picker = pickerOpen && (
    <TaskAssigneePickerDialog
      initial={assignees}
      onClose={() => setPickerOpen(false)}
      onConfirm={(selectedAssignees) => {
        setSelectedAssignees(selectedAssignees)
        setPickerOpen(false)
      }}
    />
  )
  const followerPicker = followerPickerOpen && (
    <TaskFollowerPickerDialog
      initial={followers}
      onClose={() => setFollowerPickerOpen(false)}
      onConfirm={(selectedFollowers) => {
        setFollowers(selectedFollowers)
        setFollowerPickerOpen(false)
      }}
    />
  )

  return (
    <form onSubmit={(event) => void submit(event)} className={createFormCss}>
      <div className={createFormBodyCss}>
        <label className="sr-only" htmlFor="new-task-title">
          {t('form.title')}
        </label>
        <Input
          id="new-task-title"
          ref={titleInputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('form.createTitlePlaceholder')}
          maxLength={500}
          required
        />

        <div className={createPropertyListCss}>
          <div className={createPropertyRowCss} data-align-start>
            <RiUser3Line size={19} aria-hidden="true" />
            <div className={memberEditorCss}>
              {assignees.map((assignee) => (
                <span key={assignee.id} className={memberChipCss}>
                  <TaskUserDisplay user={assignee} />
                  {assignees.length > 1 && (
                    <button
                      type="button"
                      aria-label={t('assignees.remove', {
                        name:
                          assignee.full_name ||
                          assignee.short_name ||
                          assignee.email ||
                          '',
                      })}
                      onClick={() =>
                        setSelectedAssignees(
                          assignees.filter((item) => item.id !== assignee.id)
                        )
                      }
                    >
                      <RiCloseLine size={14} aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}
              {assignees.length < 10 && (
                <Button
                  type="button"
                  size="sm"
                  variant="quaternaryText"
                  onPress={() => setPickerOpen(true)}
                >
                  {t('assignees.add')}
                </Button>
              )}
            </div>
          </div>

          <div className={createPropertyRowCss} data-align-start>
            <RiUserFollowLine size={19} aria-hidden="true" />
            <div className={memberEditorCss}>
              {followers.map((follower) => (
                <span key={follower.id} className={memberChipCss}>
                  <TaskUserDisplay user={follower} />
                  <button
                    type="button"
                    aria-label={t('followers.remove', {
                      name:
                        follower.full_name ||
                        follower.short_name ||
                        follower.email ||
                        '',
                    })}
                    onClick={() =>
                      setFollowers((current) =>
                        current.filter((item) => item.id !== follower.id)
                      )
                    }
                  >
                    <RiCloseLine size={14} aria-hidden="true" />
                  </button>
                </span>
              ))}
              <Button
                type="button"
                size="sm"
                variant="quaternaryText"
                onPress={() => setFollowerPickerOpen(true)}
              >
                {t('followers.add')}
              </Button>
            </div>
          </div>

          {(taskLists.length > 0 || taskGroups.length > 0) && (
            <div className={createPropertyRowCss} data-align-start>
              <RiListCheck3 size={19} aria-hidden="true" />
              <div className={placementControlsCss}>
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
                  selectedKey={taskListId}
                  onSelectionChange={(key) => {
                    setTaskListId(String(key))
                  }}
                />
                {taskGroups.length > 0 && (
                  <Select
                    label={<span className="sr-only">{t('groups.field')}</span>}
                    aria-label={t('groups.field')}
                    items={[
                      { value: '', label: t('groups.ungrouped') },
                      ...taskGroups.map((group) => ({
                        value: group.id,
                        label: group.name,
                      })),
                    ]}
                    selectedKey={groupId}
                    onSelectionChange={(key) => setGroupId(String(key))}
                  />
                )}
              </div>
            </div>
          )}

          <div className={createPropertyRowCss}>
            <RiCalendarLine size={19} aria-hidden="true" />
            <div className={dateControlsCss}>
              <button
                type="button"
                className={
                  dueDate === today ? dateChipSelectedCss : dateChipCss
                }
                onClick={() => setDueDate(today)}
              >
                {t('form.today')}
              </button>
              <button
                type="button"
                className={
                  dueDate === tomorrow ? dateChipSelectedCss : dateChipCss
                }
                onClick={() => setDueDate(tomorrow)}
              >
                {t('form.tomorrow')}
              </button>
              <label className={datePickerCss}>
                <span className="sr-only">{t('form.dueDate')}</span>
                <Input
                  type="date"
                  value={dueDate}
                  min={startDate || undefined}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className={createPropertyRowCss} data-align-start>
            <RiNotification3Line size={19} aria-hidden="true" />
            <div className={reminderEditorCss}>
              <span className={createPropertyLabelCss}>
                {t('taskReminder.title')}
              </span>
              <TaskReminderFields
                enabled={reminderEnabled}
                reminderMinutes={reminderMinutes}
                disabled={createMutation.isPending}
                onChange={(patch) => {
                  if (patch.enabled !== undefined)
                    setReminderEnabledOverride(patch.enabled)
                  if (patch.reminder_minutes !== undefined)
                    setReminderMinutes(patch.reminder_minutes)
                }}
              />
            </div>
          </div>

          {!parentTask && (
            <div className={createPropertyRowCss} data-align-start>
              <RiRepeatLine size={19} aria-hidden="true" />
              <div className={recurrenceControlsCss}>
                <Select
                  label={
                    <span className="sr-only">{t('recurrence.label')}</span>
                  }
                  aria-label={t('recurrence.label')}
                  items={[
                    { value: '', label: t('recurrence.none') },
                    { value: 'daily', label: t('recurrence.daily') },
                    { value: 'weekly', label: t('recurrence.weekly') },
                    { value: 'monthly', label: t('recurrence.monthly') },
                  ]}
                  selectedKey={recurrenceFrequency}
                  onSelectionChange={(key) =>
                    setRecurrenceFrequency(
                      String(key) as TaskRecurrenceFrequency | ''
                    )
                  }
                />
                {recurrenceFrequency && (
                  <div className={recurrenceOptionsCss}>
                    <label>
                      <span>{t('recurrence.every')}</span>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        value={String(recurrenceInterval)}
                        onChange={(event) =>
                          setRecurrenceInterval(
                            Math.max(1, Number(event.target.value) || 1)
                          )
                        }
                      />
                      <span>
                        {t(`recurrence.units.${recurrenceFrequency}`)}
                      </span>
                    </label>
                    <Select
                      label={
                        <span className="sr-only">{t('recurrence.ends')}</span>
                      }
                      aria-label={t('recurrence.ends')}
                      items={[
                        { value: 'never', label: t('recurrence.endNever') },
                        { value: 'date', label: t('recurrence.endDate') },
                        { value: 'count', label: t('recurrence.endCount') },
                      ]}
                      selectedKey={recurrenceEnd}
                      onSelectionChange={(key) =>
                        setRecurrenceEnd(
                          String(key) as 'never' | 'date' | 'count'
                        )
                      }
                    />
                    {recurrenceEnd === 'date' && (
                      <Input
                        aria-label={t('recurrence.endDate')}
                        type="date"
                        min={dueDate || startDate || today}
                        value={recurrenceEndDate}
                        onChange={(event) =>
                          setRecurrenceEndDate(event.target.value)
                        }
                      />
                    )}
                    {recurrenceEnd === 'count' && (
                      <Input
                        aria-label={t('recurrence.count')}
                        type="number"
                        min={1}
                        max={1000}
                        value={String(recurrenceCount)}
                        onChange={(event) =>
                          setRecurrenceCount(
                            Math.max(1, Number(event.target.value) || 1)
                          )
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className={createPropertyRowCss}>
            <RiFlagLine size={19} aria-hidden="true" />
            <div className={createSelectCss}>
              <Select
                label={<span className="sr-only">{t('form.priority')}</span>}
                aria-label={t('form.priority')}
                items={priorities.map((value) => ({
                  value,
                  label: t(`priorities.${value}`),
                }))}
                selectedKey={priority}
                onSelectionChange={(key) =>
                  setPriority(String(key) as TaskPriority)
                }
              />
            </div>
          </div>

          <label className={createPropertyRowCss} data-align-start>
            <RiFileTextLine size={19} aria-hidden="true" />
            <span className="sr-only">{t('form.description')}</span>
            <TextArea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('form.createDescriptionPlaceholder')}
              rows={3}
            />
          </label>

          <details className={startDateDisclosureCss}>
            <summary>{t('form.startDate')}</summary>
            <Input
              type="date"
              value={startDate}
              max={dueDate || undefined}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </details>
        </div>

        {createMutation.error && (
          <p role="alert" className={errorCss}>
            {t('error')}
          </p>
        )}
      </div>
      <div className={createActionsCss}>
        <Button
          type="button"
          size="action"
          variant="secondary"
          onPress={onCancel}
        >
          {t('workspace.createCancel')}
        </Button>
        <Button
          type="submit"
          size="action"
          loading={createMutation.isPending}
          isDisabled={
            !title.trim() ||
            Boolean(
              recurrenceFrequency &&
              recurrenceEnd === 'date' &&
              !recurrenceEndDate
            )
          }
        >
          {t('workspace.createSubmit')}
        </Button>
      </div>
      {picker}
      {followerPicker}
    </form>
  )
}

const errorCss = css({ margin: 0, color: 'danger.subtle-text' })

const dateInputValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`

const createFormCss = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  color: 'greyscale.900',
  fontSize: '0.875rem',
})
const createFormBodyCss = css({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  padding: '1rem',
  overflowY: 'auto',
})
const createPropertyListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})
const createPropertyRowCss = css({
  minHeight: '3rem',
  display: 'grid',
  gridTemplateColumns: '1.5rem minmax(0, 1fr)',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.375rem 0',
  color: 'greyscale.500',
  '&[data-align-start]': { alignItems: 'start', paddingTop: '0.75rem' },
})
const memberEditorCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.375rem',
})
const reminderEditorCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const createPropertyLabelCss = css({
  color: 'greyscale.800',
  fontWeight: 500,
})
const memberChipCss = css({
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingY: '0.25rem',
  paddingLeft: '0.375rem',
  paddingRight: '0.25rem',
  borderRadius: '999px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.800',
  '& button': {
    display: 'inline-flex',
    padding: '0.125rem',
    border: 0,
    borderRadius: '999px',
    backgroundColor: 'transparent',
    color: 'greyscale.500',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.200' },
  },
})
const dateControlsCss = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
})
const recurrenceControlsCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const recurrenceOptionsCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  '& label': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
  },
  '& input[type="number"]': { width: '4.5rem' },
})
const dateChipBase = {
  minHeight: '2rem',
  paddingX: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  fontSize: '0.875rem',
  cursor: 'pointer',
} as const
const dateChipCss = css({
  ...dateChipBase,
  backgroundColor: 'greyscale.50',
  color: 'greyscale.800',
  _hover: { backgroundColor: 'greyscale.100' },
})
const dateChipSelectedCss = css({
  ...dateChipBase,
  borderColor: 'selected.accent',
  backgroundColor: 'selected.bg',
  color: 'selected.text',
})
const datePickerCss = css({
  width: '9.75rem',
  '& input': { fontSize: '0.8125rem' },
})
const createSelectCss = css({
  width: '11rem',
  fontSize: '0.875rem',
})
const placementControlsCss = css({
  width: '100%',
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
  gap: '0.5rem',
  fontSize: '0.8125rem',
})
const startDateDisclosureCss = css({
  marginLeft: '2.25rem',
  color: 'greyscale.500',
  fontSize: '0.8125rem',
  '& summary': { cursor: 'pointer' },
  '& input': { width: '10rem', marginTop: '0.5rem' },
})
const createActionsCss = css({
  flexShrink: 0,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.625rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
})
