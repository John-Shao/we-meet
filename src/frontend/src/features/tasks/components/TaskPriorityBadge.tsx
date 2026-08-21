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
            ? 'danger.700'
            : priority === 'high'
              ? 'warning.700'
              : priority === 'medium'
                ? 'primary.700'
                : 'greyscale.600',
        backgroundColor:
          priority === 'urgent'
            ? 'danger.50'
            : priority === 'high'
              ? 'warning.50'
              : priority === 'medium'
                ? 'primary.50'
                : 'greyscale.100',
      })}
    >
      {t(`priorities.${priority}`)}
    </span>
  )
}
