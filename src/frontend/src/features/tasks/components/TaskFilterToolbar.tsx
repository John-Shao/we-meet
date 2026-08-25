import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  TaskPriorityFilter,
  TaskStatusFilter,
  TaskTimeFilter,
} from '../api/ApiTask'
import type { TaskWorkspaceState } from '../taskWorkspaceState'

const statusFilters: TaskStatusFilter[] = ['open', 'completed', 'all']
const timeFilters: TaskTimeFilter[] = [
  'all',
  'starting_today',
  'due_today',
  'overdue',
]
const priorityFilters: TaskPriorityFilter[] = [
  'all',
  'urgent',
  'high',
  'medium',
  'low',
]

export const TaskFilterToolbar = ({
  state,
  onStatusChange,
  onTimeChange,
  onPriorityChange,
  onClear,
}: {
  state: TaskWorkspaceState
  onStatusChange: (value: TaskStatusFilter) => void
  onTimeChange: (value: TaskTimeFilter) => void
  onPriorityChange: (value: TaskPriorityFilter) => void
  onClear: () => void
}) => {
  const { t } = useTranslation('tasks')
  const isClosed = state.status === 'completed'
  return (
    <div className={toolbarCss} aria-label={t('workspace.filters')}>
      <Select
        className={filterSelectCss}
        label={t('workspace.statusFilter')}
        aria-label={t('workspace.statusFilter')}
        items={statusFilters.map((value) => ({
          value,
          label:
            value === 'open' || value === 'all'
              ? t(`workspace.statusOptions.${value}`)
              : t(`statuses.${value}`),
        }))}
        selectedKey={state.status}
        onSelectionChange={(key) =>
          onStatusChange(String(key) as TaskStatusFilter)
        }
      />
      <Select
        className={filterSelectCss}
        label={t('timeFilters.label')}
        aria-label={t('timeFilters.label')}
        items={timeFilters.map((value) => ({
          value,
          label: t(`timeFilters.${value}`),
        }))}
        selectedKey={state.time}
        isDisabled={isClosed}
        onSelectionChange={(key) => onTimeChange(String(key) as TaskTimeFilter)}
      />
      <Select
        className={filterSelectCss}
        label={t('priorityFilters.label')}
        aria-label={t('priorityFilters.label')}
        items={priorityFilters.map((value) => ({
          value,
          label: t(`priorityFilters.${value}`),
        }))}
        selectedKey={state.priority}
        onSelectionChange={(key) =>
          onPriorityChange(String(key) as TaskPriorityFilter)
        }
      />
      <div className={toolbarActionsCss}>
        <Button variant="secondary" size="dense" onPress={onClear}>
          {t('workspace.clearFilters')}
        </Button>
      </div>
    </div>
  )
}

const toolbarCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: '0.5rem',
  padding: '0.75rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  fontSize: '0.8125rem',
  '& label': { fontSize: '0.8125rem', fontWeight: 'medium' },
  '& button': { fontSize: '0.8125rem' },
})
const filterSelectCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: { base: 'calc(50% - 0.25rem)', sm: '8rem' },
})
const toolbarActionsCss = css({
  display: 'flex',
  gap: '0.5rem',
  minWidth: 'auto!important',
  '& button': {
    height: 'control.md',
    minHeight: 'control.md',
    paddingX: '0.75rem',
  },
})
