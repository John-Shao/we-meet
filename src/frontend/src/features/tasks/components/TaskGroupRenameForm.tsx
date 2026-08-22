import { useState, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskGroup } from '../api/ApiTask'
import { useUpdateTaskGroup } from '../api/fetchTasks'

export const TaskGroupRenameForm = ({
  group,
  inputRef,
  onCancel,
  onRenamed,
}: {
  group: ApiTaskGroup
  inputRef?: RefObject<HTMLInputElement>
  onCancel: () => void
  onRenamed: () => void
}) => {
  const { t } = useTranslation('tasks')
  const [name, setName] = useState(group.name)
  const mutation = useUpdateTaskGroup()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    try {
      await mutation.mutateAsync({ groupId: group.id, name: name.trim() })
      onRenamed()
    } catch {
      // Keep the name so the user can correct it or retry.
    }
  }

  return (
    <form className={formCss} onSubmit={(event) => void submit(event)}>
      <label>
        {t('groups.name')}
        <Input
          ref={inputRef}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {mutation.error && (
        <p role="alert" className={errorCss}>
          {t('groups.renameError')}
        </p>
      )}
      <div className={actionsCss}>
        <Button type="button" size="action" variant="secondary" onPress={onCancel}>
          {t('workspace.createCancel')}
        </Button>
        <Button
          type="submit"
          size="action"
          loading={mutation.isPending}
          isDisabled={!name.trim() || name.trim() === group.name}
        >
          {t('groups.rename')}
        </Button>
      </div>
    </form>
  )
}

const formCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem',
  fontSize: '0.8125rem',
  '& label': {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
})
const actionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.625rem',
})
const errorCss = css({ margin: 0, color: 'danger.subtle-text' })
