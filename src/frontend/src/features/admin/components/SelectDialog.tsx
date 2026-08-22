import { SelectCompat } from '@/primitives/SelectCompat'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  isOpen: boolean
  title: string
  label?: string
  options: SelectOption[]
  initialValue: string
  confirmLabel: string
  submitting?: boolean
  onSubmit: (value: string) => void
  onClose: () => void
}

/**
 * A single-dropdown modal for the console's "change role / move department"
 * flows. Submits the chosen option value.
 */
export const SelectDialog = ({
  isOpen,
  title,
  label,
  options,
  initialValue,
  confirmLabel,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (isOpen) setValue(initialValue)
  }, [isOpen, initialValue])

  return (
    <Dialog
      isOpen={isOpen}
      title={title}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <label
        className={css({
          display: 'block',
          marginBottom: '1.25rem',
          fontSize: '0.875rem',
          color: 'greyscale.700',
          minWidth: '18rem',
        })}
      >
        {label && (
          <span className={css({ display: 'block', marginBottom: '0.375rem' })}>
            {label}
          </span>
        )}
        <SelectCompat
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={cx(
            selectChrome,
            css({
              width: '100%',
              padding: '0.375rem 0.5rem',
              border: '1px solid token(colors.control.border)',
              borderRadius: '4px',
              backgroundColor: 'greyscale.000',
              color: 'default.text',
              fontSize: '0.875rem',
            })
          )}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectCompat>
      </label>
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
          variant="primary"
          size="sm"
          isDisabled={submitting}
          loading={submitting}
          onPress={() => onSubmit(value)}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
