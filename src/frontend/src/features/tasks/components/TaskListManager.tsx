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
}: {
  taskLists: ApiTaskList[]
  onCreated?: (taskList: ApiTaskList) => void
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
        <label className={fieldCss}>
          {t('taskLists.name')}
          <Input
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={fieldCss}>
          {t('taskLists.description')}
          <TextArea
            value={description}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className={formActionsCss}>
          <Select
            label={t('labels.color')}
            aria-label={t('labels.color')}
            items={colors.map((value) => ({
              value,
              label: t(`labels.colors.${value}`),
            }))}
            selectedKey={color}
            onSelectionChange={(key) =>
              setColor(String(key) as TaskLabelColor)
            }
          />
          <Button
            type="submit"
            size="dense"
            loading={createMutation.isPending}
            isDisabled={!name.trim()}
          >
            {t('taskLists.create')}
          </Button>
        </div>
        {createMutation.error && (
          <p role="alert" className={errorCss}>
            {t('taskLists.error')}
          </p>
        )}
      </form>

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
    </div>
  )
}

const managerCss = css({
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem',
  overflowY: 'auto',
  fontSize: '0.8125rem',
})
const formCss = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: '1fr 1.5fr auto' },
  alignItems: 'end',
  gap: '0.75rem',
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
  alignItems: 'end',
  gap: '0.5rem',
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
