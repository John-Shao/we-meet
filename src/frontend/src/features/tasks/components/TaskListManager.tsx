import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { RiDeleteBinLine, RiListCheck } from '@remixicon/react'

import { useConfirm } from '@/components/ConfirmProvider'
import { Button, Input, TextArea } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { ApiTaskList, TaskLabelColor } from '../api/ApiTask'
import { useCreateTaskList, useDeleteTaskList } from '../api/fetchTasks'

const colors: TaskLabelColor[] = [
  'grey',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
]

export const TaskListManager = ({
  taskLists,
  onCreated,
  onCancel,
}: {
  taskLists: ApiTaskList[]
  onCreated?: (taskList: ApiTaskList) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const createMutation = useCreateTaskList()
  const deleteMutation = useDeleteTaskList()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<TaskLabelColor>('blue')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    try {
      const taskList = await createMutation.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        color,
      })
      setName('')
      setDescription('')
      setColor('blue')
      onCreated?.(taskList)
    } catch {
      // Keep the draft visible for correction or retry.
    }
  }

  const remove = async (taskList: ApiTaskList) => {
    const accepted = await confirm({
      title: t('taskLists.deleteTitle'),
      message: t('taskLists.deleteDescription', { name: taskList.name }),
      confirmLabel: t('taskLists.deleteConfirm'),
      danger: true,
    })
    if (accepted) deleteMutation.mutate(taskList.id)
  }

  return (
    <div className={managerCss}>
      <form className={formCss} onSubmit={(event) => void submit(event)}>
        <div className={formHeadingCss}>
          <h3>{t('taskLists.create')}</h3>
          <p>{t('taskLists.createHint')}</p>
        </div>
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
          label={t('labels.color')}
          aria-label={t('labels.color')}
          items={colors.map((value) => ({
            value,
            label: t(`labels.colors.${value}`),
          }))}
          selectedKey={color}
          onSelectionChange={(key) => setColor(String(key) as TaskLabelColor)}
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
            {t('taskLists.create')}
          </Button>
        </div>
      </form>

      {taskLists.length > 0 && (
        <section className={existingListsCss}>
          <h3>{t('taskLists.title')}</h3>
          <ul className={listCss}>
            {taskLists.map((taskList) => (
              <li key={taskList.id}>
                <RiListCheck
                  size={19}
                  data-color={taskList.color}
                  className={iconCss}
                />
                <div>
                  <strong>{taskList.name}</strong>
                  <span>
                    {t('taskLists.taskCount', { count: taskList.task_count })}
                  </span>
                </div>
                {taskList.can_manage && (
                  <Button
                    variant="quaternaryDanger"
                    size="icon28"
                    aria-label={t('taskLists.deleteNamed', {
                      name: taskList.name,
                    })}
                    loading={
                      deleteMutation.isPending &&
                      deleteMutation.variables === taskList.id
                    }
                    onPress={() => void remove(taskList)}
                  >
                    <RiDeleteBinLine size={16} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const managerCss = css({
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
  padding: '1.25rem',
  overflowY: 'auto',
  fontSize: '0.8125rem',
})
const formCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1.25rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.75rem',
  backgroundColor: 'greyscale.050',
})
const formHeadingCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  '& h3': { margin: 0, color: 'default.text', fontSize: '0.9375rem' },
  '& p': { margin: 0, color: 'default.subtle-text', fontSize: '0.75rem' },
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
const existingListsCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  '& > h3': { margin: 0, color: 'default.text', fontSize: '0.875rem' },
})
const listCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  '& li': {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    border: '1px solid token(colors.greyscale.200)',
    borderRadius: '8px',
  },
  '& li > div': { display: 'flex', flexDirection: 'column' },
  '& strong': { fontSize: '0.8125rem' },
  '& span': { color: 'default.subtle-text', fontSize: '0.6875rem' },
})
const iconCss = css({ color: 'primary.500' })
const errorCss = css({
  gridColumn: '1 / -1',
  margin: 0,
  color: 'danger.subtle-text',
})
