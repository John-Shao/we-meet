import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { ApiTaskList, ApiTaskListGroup, TaskColor } from '../api/ApiTask'
import { useCreateTaskList } from '../api/fetchTasks'

const colors: TaskColor[] = [
  'grey',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
]

export const TaskListManager = ({
  taskListGroups,
  defaultListGroupId,
  onCreated,
  onCancel,
}: {
  taskListGroups: ApiTaskListGroup[]
  defaultListGroupId?: string
  onCreated?: (taskList: ApiTaskList) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  const createMutation = useCreateTaskList()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<TaskColor>('blue')
  const [listGroupId, setListGroupId] = useState(defaultListGroupId || '')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    try {
      const taskList = await createMutation.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        color,
        list_group_id: listGroupId || null,
      })
      setName('')
      setDescription('')
      setColor('blue')
      onCreated?.(taskList)
    } catch {
      // Keep the draft visible for correction or retry.
    }
  }

  return (
    <div className={managerCss}>
      <form className={formCss} onSubmit={(event) => void submit(event)}>
        <label className={fieldCss}>
          {t('taskLists.name')}
          <Input
            value={name}
            maxLength={80}
            placeholder={t('taskLists.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={fieldCss}>
          {t('taskLists.description')}
          <TextArea
            value={description}
            rows={2}
            placeholder={t('taskLists.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <Select
          label={t('taskListGroups.field')}
          aria-label={t('taskListGroups.field')}
          items={[
            { value: '', label: t('taskListGroups.none') },
            ...taskListGroups.map((group) => ({
              value: group.id,
              label: group.name,
            })),
          ]}
          selectedKey={listGroupId}
          onSelectionChange={(key) => setListGroupId(String(key))}
        />
        <Select
          label={t('taskLists.color')}
          aria-label={t('taskLists.color')}
          items={colors.map((value) => ({
            value,
            label: t(`taskLists.colors.${value}`),
          }))}
          selectedKey={color}
          onSelectionChange={(key) => setColor(String(key) as TaskColor)}
        />
        {createMutation.error && (
          <p role="alert" className={errorCss}>
            {t('taskLists.error')}
          </p>
        )}
        <div className={formActionsCss}>
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
            isDisabled={!name.trim()}
          >
            {t('workspace.createSubmit')}
          </Button>
        </div>
      </form>
    </div>
  )
}

const managerCss = css({
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
  padding: '1rem',
  overflowY: 'auto',
  fontSize: '0.875rem',
})
const formCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
})
const fieldCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  color: 'default.subtle-text',
  fontSize: '0.75rem',
})
const formActionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingTop: '0.25rem',
})
const errorCss = css({
  gridColumn: '1 / -1',
  margin: 0,
  color: 'danger.subtle-text',
})
