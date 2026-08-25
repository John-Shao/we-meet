import { useState, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCalendarLine,
  RiFileTextLine,
  RiFlagLine,
  RiListCheck3,
  RiUser3Line,
} from '@remixicon/react'

import { ContactPicker, type DirectoryMember } from '@/features/contacts'
import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskList,
  ApiTaskUser,
  TaskPriority,
} from '../api/ApiTask'
import { useCreateTask } from '../api/fetchTasks'
import { TaskUserDisplay } from './TaskUserDisplay'

const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

export const TaskForm = ({
  taskLists,
  defaultTaskListId,
  defaultGroupId,
  titleInputRef,
  onCancel,
  onSaved,
}: {
  taskLists: ApiTaskList[]
  defaultTaskListId?: string
  defaultGroupId?: string
  titleInputRef?: RefObject<HTMLInputElement>
  onCancel: () => void
  onSaved: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignee, setAssignee] = useState<ApiTaskUser | null>(null)
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [taskListId, setTaskListId] = useState(defaultTaskListId || '')
  const [groupId, setGroupId] = useState(defaultGroupId || '')
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const createMutation = useCreateTask()
  const today = dateInputValue(new Date())
  const tomorrowDate = new Date()
  tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrow = dateInputValue(tomorrowDate)
  const selectedTaskList = taskLists.find((item) => item.id === taskListId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (!cleanTitle) return
    try {
      const payload = {
        title: cleanTitle,
        description: description.trim(),
        assignee_id: assignee?.id,
        priority,
        task_list_id: taskListId || null,
        group_id: groupId || null,
        start_date: startDate || null,
        due_date: dueDate || null,
      }
      const saved = await createMutation.mutateAsync(payload)
      onSaved(saved)
    } catch {
      // Preserve the draft so the user can correct it or retry.
    }
  }

  const picker = pickerOpen && (
    <ContactPicker
      includeSelf
      title={t('form.selectAssignee')}
      searchPlaceholder={t('form.searchAssignee')}
      onClose={() => setPickerOpen(false)}
      onSelect={(member: DirectoryMember) => {
        setAssignee({
          id: member.id,
          full_name: member.full_name,
          short_name: member.short_name,
          email: member.email,
          avatar_url: member.avatar_url,
        })
        setPickerOpen(false)
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
          <div className={createPropertyRowCss}>
            <RiUser3Line size={19} aria-hidden="true" />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className={assigneeButtonCss}
              onPress={() => setPickerOpen(true)}
            >
              {assignee ? (
                <TaskUserDisplay user={assignee} />
              ) : (
                t('form.assigneeSelf')
              )}
            </Button>
          </div>

          {taskLists.length > 0 && (
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
                    setGroupId('')
                  }}
                />
                {selectedTaskList && selectedTaskList.groups.length > 0 && (
                  <Select
                    label={<span className="sr-only">{t('groups.field')}</span>}
                    aria-label={t('groups.field')}
                    items={[
                      { value: '', label: t('groups.ungrouped') },
                      ...selectedTaskList.groups.map((group) => ({
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
          isDisabled={!title.trim()}
        >
          {t('workspace.createSubmit')}
        </Button>
      </div>
      {picker}
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
const assigneeButtonCss = css({
  justifySelf: 'start',
  fontSize: '0.875rem',
})
const dateControlsCss = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
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
