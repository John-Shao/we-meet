import { useState, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { ContactPicker, type DirectoryMember } from '@/features/contacts'
import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskLabel,
  ApiTaskUser,
  TaskPriority,
} from '../api/ApiTask'
import { useCreateTask, usePatchTask } from '../api/fetchTasks'
import { taskDisplayName } from '../taskUi'
import { TaskLabelSelector } from './TaskLabelSelector'

const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent']

export const TaskForm = ({
  mode,
  task,
  labels,
  titleInputRef,
  onCancel,
  onSaved,
}: {
  mode: 'create' | 'edit'
  task?: ApiTask
  labels: ApiTaskLabel[]
  titleInputRef?: RefObject<HTMLInputElement>
  onCancel: () => void
  onSaved: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const [assignee, setAssignee] = useState<ApiTaskUser | null>(
    task?.assignee || null
  )
  const [priority, setPriority] = useState<TaskPriority>(
    task?.priority || 'none'
  )
  const [labelIds, setLabelIds] = useState<string[]>(
    task?.labels.map((label) => label.id) || []
  )
  const [startDate, setStartDate] = useState(task?.start_date || '')
  const [dueDate, setDueDate] = useState(task?.due_date || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const createMutation = useCreateTask()
  const patchMutation = usePatchTask()
  const mutation = mode === 'create' ? createMutation : patchMutation

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
        label_ids: labelIds,
        start_date: startDate || null,
        due_date: dueDate || null,
      }
      const saved =
        mode === 'create'
          ? await createMutation.mutateAsync(payload)
          : await patchMutation.mutateAsync({
              taskId: task!.id,
              patch: payload,
            })
      onSaved(saved)
    } catch {
      // Preserve the draft so the user can correct it or retry.
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={formCss}>
      <label className={fieldCss}>
        {t('form.title')}
        <Input
          ref={titleInputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('form.titlePlaceholder')}
          maxLength={500}
          required
        />
      </label>
      <label className={fieldCss}>
        {t('form.description')}
        <TextArea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t('form.descriptionPlaceholder')}
          rows={5}
        />
      </label>
      <label className={fieldCss}>
        {t('form.assignee')}
        <Button
          type="button"
          variant="secondary"
          className={css({ width: '100%', justifyContent: 'flex-start' })}
          onPress={() => setPickerOpen(true)}
        >
          {assignee ? taskDisplayName(assignee) : t('form.assigneeSelf')}
        </Button>
      </label>
      <Select
        label={t('form.priority')}
        aria-label={t('form.priority')}
        items={priorities.map((value) => ({
          value,
          label: t(`priorities.${value}`),
        }))}
        selectedKey={priority}
        onSelectionChange={(key) => setPriority(String(key) as TaskPriority)}
      />
      <TaskLabelSelector
        labels={labels}
        selectedIds={labelIds}
        onChange={setLabelIds}
      />
      <div className={twoColumnsCss}>
        <label className={fieldCss}>
          {t('form.startDate')}
          <Input
            type="date"
            value={startDate}
            max={dueDate || undefined}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label className={fieldCss}>
          {t('form.dueDate')}
          <Input
            type="date"
            value={dueDate}
            min={startDate || undefined}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
      </div>
      {mutation.error && (
        <p role="alert" className={errorCss}>
          {t('error')}
        </p>
      )}
      <div className={actionsCss}>
        <Button type="button" variant="secondary" onPress={onCancel}>
          {t('actions.cancelEdit')}
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          isDisabled={!title.trim()}
        >
          {mode === 'create' ? t('form.create') : t('actions.save')}
        </Button>
      </div>
      {pickerOpen && (
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
            })
            setPickerOpen(false)
          }}
        />
      )}
    </form>
  )
}

const formCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem',
})

const fieldCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  color: 'default.text',
  fontSize: '0.875rem',
})

const twoColumnsCss = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
  gap: '0.75rem',
})

const actionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.625rem',
  paddingTop: '0.25rem',
})
const errorCss = css({ margin: 0, color: 'danger.subtle-text' })
