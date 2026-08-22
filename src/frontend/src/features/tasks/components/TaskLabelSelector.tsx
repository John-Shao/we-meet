import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { ApiTaskLabel } from '../api/ApiTask'
import { TaskLabelBadge } from './TaskLabelBadge'

export const TaskLabelSelector = ({
  labels,
  selectedIds,
  onChange,
  max = 5,
  compact = false,
}: {
  labels: ApiTaskLabel[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  max?: number
  compact?: boolean
}) => {
  const { t } = useTranslation('tasks')
  const selected = new Set(selectedIds)

  return (
    <fieldset className={compact ? compactFieldsetCss : fieldsetCss}>
      <legend className={compact ? 'sr-only' : legendCss}>
        {t('labels.field')} ({selectedIds.length}/{max})
      </legend>
      {labels.length === 0 ? (
        <span
          className={css({
            color: 'default.subtle-text',
            fontSize: '0.8125rem',
          })}
        >
          {t('labels.empty')}
        </span>
      ) : (
        <div
          className={css({
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.375rem',
          })}
        >
          {labels.map((label) => {
            const checked = selected.has(label.id)
            const disabled = !checked && selectedIds.length >= max
            return (
              <label
                key={label.id}
                className={compact ? compactLabelCss : labelCss}
                data-selected={(compact && checked) || undefined}
                data-disabled={(compact && disabled) || undefined}
              >
                <input
                  className={compact ? 'sr-only' : undefined}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange(
                      checked
                        ? selectedIds.filter((id) => id !== label.id)
                        : [...selectedIds, label.id]
                    )
                  }
                />
                <TaskLabelBadge label={label} />
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

const fieldsetCss = css({
  minWidth: 0,
  margin: 0,
  padding: 0,
  border: 0,
})
const compactFieldsetCss = css({
  minWidth: 0,
  margin: 0,
  padding: 0,
  border: 0,
  color: 'greyscale.700',
  fontSize: '0.8125rem',
})
const legendCss = css({
  marginBottom: '0.375rem',
  fontSize: '0.875rem',
  color: 'default.text',
})
const labelCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  cursor: 'pointer',
  '&:has(input:disabled)': { cursor: 'not-allowed', opacity: 0.5 },
})
const compactLabelCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.125rem',
  border: '1px solid transparent',
  borderRadius: '6px',
  cursor: 'pointer',
  '&[data-selected]': {
    borderColor: 'selected.accent',
    backgroundColor: 'selected.bg',
  },
  '&[data-disabled]': { cursor: 'not-allowed', opacity: 0.5 },
})
