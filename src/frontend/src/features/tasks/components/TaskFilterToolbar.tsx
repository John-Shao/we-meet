import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RiCloseLine, RiFilter3Line } from '@remixicon/react'

import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  TaskColumnId,
  TaskGrouping,
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
  'none',
]
const groupingOptions: TaskGrouping[] = [
  'none',
  'custom',
  'task_list',
  'start_date',
  'due_date',
  'creator',
]
const columnOptions: TaskColumnId[] = [
  'title',
  'assignee',
  'priority',
  'startDate',
  'dueDate',
  'taskList',
  'customGroup',
  'creator',
  'createdAt',
  'completedAt',
]

export const TaskFilterToolbar = ({
  state,
  resultCount,
  onStatusChange,
  onTimeChange,
  onPriorityChange,
  onGroupingChange,
  onColumnsChange,
  statusLocked = false,
  onClear,
}: {
  state: TaskWorkspaceState
  resultCount: number
  onStatusChange: (value: TaskStatusFilter) => void
  onTimeChange: (value: TaskTimeFilter) => void
  onPriorityChange: (value: TaskPriorityFilter) => void
  onGroupingChange: (value: TaskGrouping) => void
  onColumnsChange: (value: TaskColumnId[]) => void
  statusLocked?: boolean
  onClear: () => void
}) => {
  const { t } = useTranslation('tasks')
  const columnPickerRef = useRef<HTMLDetailsElement>(null)
  const selectedColumns = state.columns ?? columnOptions.slice(0, 8)
  const isClosed = state.status === 'completed'
  const defaultStatus = state.mode === 'board' ? 'all' : 'open'
  const activeFilters = [
    state.status !== defaultStatus
      ? {
          key: 'status',
          label:
            state.status === 'open' || state.status === 'all'
              ? t(`workspace.statusOptions.${state.status}`)
              : t(`statuses.${state.status}`),
          clear: () => onStatusChange(defaultStatus),
        }
      : null,
    state.time !== 'all'
      ? {
          key: 'time',
          label: t(`timeFilters.${state.time}`),
          clear: () => onTimeChange('all'),
        }
      : null,
    state.priority !== 'all'
      ? {
          key: 'priority',
          label: t(`priorityFilters.${state.priority}`),
          clear: () => onPriorityChange('all'),
        }
      : null,
  ].filter((filter): filter is NonNullable<typeof filter> => Boolean(filter))

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const picker = columnPickerRef.current
      if (
        picker?.open &&
        event.target instanceof Node &&
        !picker.contains(event.target)
      ) {
        picker.open = false
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && columnPickerRef.current?.open) {
        columnPickerRef.current.open = false
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePress, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  return (
    <section className={filterRegionCss} aria-label={t('workspace.filters')}>
      <div className={toolbarCss}>
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
          isDisabled={statusLocked}
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
          onSelectionChange={(key) =>
            onTimeChange(String(key) as TaskTimeFilter)
          }
        />
        <Select
          className={filterSelectCss}
          label={t('workspace.grouping.label')}
          aria-label={t('workspace.grouping.label')}
          items={groupingOptions.map((value) => ({
            value,
            label: t(`workspace.grouping.${value}`),
          }))}
          selectedKey={state.grouping ?? 'none'}
          onSelectionChange={(key) =>
            onGroupingChange(String(key) as TaskGrouping)
          }
        />
        <details ref={columnPickerRef} className={columnPickerCss}>
          <summary>{t('workspace.fieldSettings')}</summary>
          <div>
            {columnOptions.map((column) => {
              const checked = selectedColumns.includes(column)
              return (
                <label key={column}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={column === 'title'}
                    onChange={() =>
                      onColumnsChange(
                        checked
                          ? selectedColumns.filter((item) => item !== column)
                          : [...selectedColumns, column]
                      )
                    }
                  />
                  {t(`workspace.columns.${column}`)}
                </label>
              )
            })}
          </div>
        </details>
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
      </div>
      {activeFilters.length > 0 && (
        <div className={activeFiltersCss} aria-live="polite">
          <span className={filterResultCss}>
            <RiFilter3Line size={15} aria-hidden="true" />
            {t('workspace.filteredResultCount', { count: resultCount })}
          </span>
          <div className={filterChipsCss}>
            {activeFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className={filterChipCss}
                aria-label={t('workspace.removeFilter', {
                  filter: filter.label,
                })}
                onClick={filter.clear}
              >
                <span>{filter.label}</span>
                <RiCloseLine size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
          <Button variant="quaternaryText" size="dense" onPress={onClear}>
            {t('workspace.clearFilters')}
          </Button>
        </div>
      )}
    </section>
  )
}

const filterRegionCss = css({
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
})
const toolbarCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: '0.5rem',
  padding: '0.625rem 1rem',
  fontSize: '0.8125rem',
  '& label': { fontSize: '0.8125rem', fontWeight: 'medium' },
  '& button': { fontSize: '0.8125rem' },
})
const filterSelectCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: '8rem',
})
const columnPickerCss = css({
  position: 'relative',
  alignSelf: 'end',
  '& summary': {
    minHeight: '2rem',
    display: 'flex',
    alignItems: 'center',
    paddingX: '0.75rem',
    border: '1px solid token(colors.greyscale.300)',
    borderRadius: '6px',
    backgroundColor: 'greyscale.000',
    cursor: 'pointer',
    listStyle: 'none',
  },
  '& > div': {
    position: 'absolute',
    zIndex: 'dropdown',
    top: 'calc(100% + 0.25rem)',
    right: 0,
    minWidth: '11rem',
    display: 'grid',
    gap: '0.5rem',
    padding: '0.75rem',
    border: '1px solid token(colors.greyscale.200)',
    borderRadius: '8px',
    backgroundColor: 'greyscale.000',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
  },
  '& label': { display: 'flex', alignItems: 'center', gap: '0.5rem' },
})
const activeFiltersCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0 1rem 0.625rem',
  '& button': {
    fontSize: '0.75rem',
  },
})
const filterResultCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  color: 'greyscale.600',
  fontSize: '0.75rem',
})
const filterChipsCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.375rem',
})
const filterChipCss = css({
  minHeight: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.125rem 0.5rem',
  border: '1px solid token(colors.primary.200)',
  borderRadius: '999px',
  backgroundColor: 'primary.50',
  color: 'primary.700',
  cursor: 'pointer',
  _hover: { backgroundColor: 'primary.100' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '1px',
  },
})
