import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { ApiTaskLabel } from '../api/ApiTask'
import { TaskLabelBadge } from './TaskLabelBadge'

export const TaskLabelSelector = ({
  labels,
  selectedIds,
  onChange,
  max = 5,
}: {
  labels: ApiTaskLabel[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  max?: number
}) => {
  const { t } = useTranslation('tasks')
  const selected = new Set(selectedIds)

  return (
    <fieldset
      className={css({
        minWidth: 0,
        margin: 0,
        padding: 0,
        border: 0,
      })}
    >
      <legend
        className={css({
          marginBottom: '0.375rem',
          fontSize: '0.875rem',
          color: 'default.text',
        })}
      >
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
                className={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                })}
              >
                <input
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
