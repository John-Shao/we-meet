import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

interface Props {
  isOpen: boolean
  title: string
  /** Accessible label for the text field (falls back to the title). */
  label?: string
  initialValue?: string
  confirmLabel: string
  submitting?: boolean
  onSubmit: (value: string) => void
  onClose: () => void
}

/**
 * A single-text-field modal used for create / rename flows in the console
 * (ConfirmProvider only offers confirm/alert, no prompt). Submits the trimmed
 * value; the confirm button is disabled while empty or in flight.
 */
export const TextPromptDialog = ({
  isOpen,
  title,
  label,
  initialValue,
  confirmLabel,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [value, setValue] = useState(initialValue ?? '')

  useEffect(() => {
    if (isOpen) setValue(initialValue ?? '')
  }, [isOpen, initialValue])

  const trimmed = value.trim()
  const submit = () => {
    if (trimmed && !submitting) onSubmit(trimmed)
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={title}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {/* eslint-disable jsx-a11y/no-autofocus -- 这个对话框整体只为填这一个值
            (新建/重命名),打开就该能直接打字。RAC 的 useDialog 默认把焦点放在对话框
            **容器**上(源码原话:"Focus the dialog itself on mount, unless a child
            element is already focused"),所以只能由子元素 autoFocus 抢在它前面 ——
            与 JoinMeetingDialog 同款做法。 */}
        <Input
          autoFocus
          aria-label={label ?? title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={css({ marginBottom: '1.25rem', minWidth: '18rem' })}
        />
        {/* eslint-enable jsx-a11y/no-autofocus */}
        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
          })}
        >
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={!trimmed || submitting}
            loading={submitting}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
