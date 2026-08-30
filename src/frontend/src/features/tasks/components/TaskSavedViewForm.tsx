import { useState, type FormEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

export const TaskSavedViewForm = ({
  initialName = '',
  inputRef,
  submitting,
  error,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initialName?: string
  inputRef?: RefObject<HTMLInputElement>
  submitting: boolean
  error: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: (name: string) => Promise<void>
}) => {
  const { t } = useTranslation('tasks')
  const [name, setName] = useState(initialName)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    if (!name.trim()) return
    await onSubmit(name.trim())
  }

  return (
    <form className={formCss} onSubmit={(event) => void submit(event)}>
      <label>
        {t('savedViews.name')}
        <Input
          ref={inputRef}
          value={name}
          maxLength={80}
          placeholder={t('savedViews.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className={errorCss}>
          {t('savedViews.saveError')}
        </p>
      )}
      <div className={actionsCss}>
        <Button
          type="button"
          variant="secondary"
          size="action"
          onPress={onCancel}
        >
          {t('workspace.createCancel')}
        </Button>
        <Button
          type="submit"
          size="action"
          loading={submitting}
          isDisabled={!name.trim() || name.trim() === initialName}
        >
          {submitLabel}
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
