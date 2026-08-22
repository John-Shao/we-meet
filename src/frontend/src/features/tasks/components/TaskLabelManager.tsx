import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/ConfirmProvider'
import { Button, Input } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { ApiTaskLabel, TaskLabelColor } from '../api/ApiTask'
import {
  useCreateTaskLabel,
  useDeleteTaskLabel,
  useUpdateTaskLabel,
} from '../api/fetchTasks'
import { TaskLabelBadge } from './TaskLabelBadge'

const colors: TaskLabelColor[] = [
  'grey',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
]

export const TaskLabelManager = ({
  labels,
  standalone = false,
}: {
  labels: ApiTaskLabel[]
  standalone?: boolean
}) => {
  const { t } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const createMutation = useCreateTaskLabel()
  const updateMutation = useUpdateTaskLabel()
  const deleteMutation = useDeleteTaskLabel()
  const [name, setName] = useState('')
  const [color, setColor] = useState<TaskLabelColor>('grey')
  const [editing, setEditing] = useState<ApiTaskLabel | null>(null)

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    try {
      await createMutation.mutateAsync({ name: name.trim(), color })
      setName('')
      setColor('grey')
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editing?.name.trim()) return
    try {
      await updateMutation.mutateAsync({
        labelId: editing.id,
        patch: { name: editing.name.trim(), color: editing.color },
      })
      setEditing(null)
    } catch {
      // Keep the row open so the user can retry.
    }
  }

  const remove = async (label: ApiTaskLabel) => {
    const accepted = await confirm({
      title: t('labels.deleteTitle'),
      message: t('labels.deleteDescription', { name: label.name }),
      confirmLabel: t('labels.deleteConfirm'),
      danger: true,
    })
    if (accepted) deleteMutation.mutate(label.id)
  }

  const content = (
    <>
      <form
        onSubmit={(event) => void submitCreate(event)}
        className={css({
          display: 'grid',
          gridTemplateColumns: { base: '1fr', sm: '2fr 1fr auto' },
          alignItems: 'end',
          gap: '0.5rem',
          marginTop: standalone ? 0 : '0.75rem',
        })}
      >
        <label className={fieldCss}>
          {t('labels.name')}
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={32}
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
        <Button
          type="submit"
          size="dense"
          loading={createMutation.isPending}
          isDisabled={!name.trim()}
        >
          {t('labels.create')}
        </Button>
      </form>

      <ul
        className={css({
          listStyle: 'none',
          padding: 0,
          marginBottom: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        })}
      >
        {labels.map((label) => (
          <li key={label.id}>
            {editing?.id === label.id ? (
              <form
                onSubmit={(event) => void submitEdit(event)}
                className={rowCss}
              >
                <Input
                  aria-label={t('labels.name')}
                  value={editing.name}
                  maxLength={32}
                  onChange={(event) =>
                    setEditing({ ...editing, name: event.target.value })
                  }
                />
                <Select
                  label={t('labels.color')}
                  aria-label={t('labels.color')}
                  items={colors.map((value) => ({
                    value,
                    label: t(`labels.colors.${value}`),
                  }))}
                  selectedKey={editing.color}
                  onSelectionChange={(key) =>
                    setEditing({
                      ...editing,
                      color: String(key) as TaskLabelColor,
                    })
                  }
                />
                <Button type="submit" size="dense">
                  {t('actions.save')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="dense"
                  onPress={() => setEditing(null)}
                >
                  {t('actions.cancelEdit')}
                </Button>
              </form>
            ) : (
              <div className={rowCss}>
                <TaskLabelBadge label={label} />
                <span className={css({ flex: 1 })} />
                {label.can_manage && (
                  <>
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => setEditing(label)}
                    >
                      {t('labels.rename')}
                    </Button>
                    <Button
                      variant="danger"
                      size="dense"
                      loading={deleteMutation.isPending}
                      onPress={() => void remove(label)}
                    >
                      {t('labels.delete')}
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {(createMutation.error ||
        updateMutation.error ||
        deleteMutation.error) && (
        <p role="alert" className={css({ color: 'danger.subtle-text' })}>
          {t('labels.error')}
        </p>
      )}
    </>
  )

  if (standalone) return <div>{content}</div>

  return (
    <details
      className={css({
        border: '1px solid token(colors.greyscale.200)',
        borderRadius: '10px',
        padding: '0.75rem',
        backgroundColor: 'greyscale.50',
      })}
    >
      <summary
        className={css({
          cursor: 'pointer',
          color: 'default.text',
          fontWeight: '600',
        })}
      >
        {t('labels.manage')}
      </summary>
      {content}
    </details>
  )
}

const fieldCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.875rem',
  color: 'default.text',
})

const rowCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
})
