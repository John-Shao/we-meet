import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  ApiTaskLabel,
  TaskPriorityFilter,
  TaskStatusFilter,
  TaskTimeFilter,
} from '../api/ApiTask'
import type { TaskWorkspaceState } from '../taskWorkspaceState'

const statusFilters: TaskStatusFilter[] = [
  'open',
  'all',
  'todo',
  'in_progress',
  'completed',
  'canceled',
]
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
  'none',
]

export const TaskFilterToolbar = ({
  state,
  labels,
  onStatusChange,
  onTimeChange,
  onPriorityChange,
  onLabelChange,
  onClear,
  onManageLabels,
}: {
  state: TaskWorkspaceState
  labels: ApiTaskLabel[]
  onStatusChange: (value: TaskStatusFilter) => void
  onTimeChange: (value: TaskTimeFilter) => void
  onPriorityChange: (value: TaskPriorityFilter) => void
  onLabelChange: (value: string) => void
  onClear: () => void
  onManageLabels: () => void
}) => {
  const { t } = useTranslation('tasks')
  const isClosed = state.status === 'completed' || state.status === 'canceled'
  return (
    <div className={toolbarCss} aria-label={t('workspace.filters')}>
      <Select
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
      <Select
        label={t('labels.filter')}
        aria-label={t('labels.filter')}
        items={[
          { value: 'all', label: t('labels.all') },
          { value: 'none', label: t('labels.unlabeled') },
          ...labels.map((label) => ({ value: label.id, label: label.name })),
        ]}
        selectedKey={state.label}
        onSelectionChange={(key) => onLabelChange(String(key))}
      />
      <div className={toolbarActionsCss}>
        <Button variant="secondary" size="dense" onPress={onClear}>
          {t('workspace.clearFilters')}
        </Button>
        <Button variant="secondary" size="dense" onPress={onManageLabels}>
          {t('workspace.manageLabels')}
        </Button>
      </div>
    </div>
  )
}

const toolbarCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: '0.625rem',
  padding: '0.75rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  fontSize: '0.8125rem',
  '& label': { fontSize: '0.75rem' },
  '& button': { fontSize: '0.8125rem' },
  '& > *': { minWidth: { base: 'calc(50% - 0.5rem)', sm: '140px' } },
})
const toolbarActionsCss = css({
  display: 'flex',
  gap: '0.5rem',
  minWidth: 'auto!important',
})
