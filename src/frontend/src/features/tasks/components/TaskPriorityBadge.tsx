import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import type { TaskPriority } from '../api/ApiTask'

export const TaskPriorityBadge = ({ priority }: { priority: TaskPriority }) => {
  const { t } = useTranslation('tasks')
  if (priority === 'none') return null

  return (
    <span
      data-priority={priority}
      className={css({
        flexShrink: 0,
        borderRadius: '999px',
        paddingX: '0.625rem',
        paddingY: '0.25rem',
        fontSize: '0.75rem',
        fontWeight: '600',
        color:
          priority === 'urgent'
            ? 'danger.subtle-text'
            : priority === 'high'
              ? 'warning.subtle-text'
              : priority === 'medium'
                ? 'primary.subtle-text'
                : 'greyscale.600',
        backgroundColor:
          priority === 'urgent'
            ? 'danger.subtle'
            : priority === 'high'
              ? 'warning.subtle'
              : priority === 'medium'
                ? 'primary.subtle'
                : 'greyscale.100',
      })}
    >
      {t(`priorities.${priority}`)}
    </span>
  )
}
