import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RiArrowDownSLine, RiCloseLine, RiFilter3Line } from '@remixicon/react'

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
  resultCount,
  onStatusChange,
  onTimeChange,
  onPriorityChange,
  onClear,
}: {
  state: TaskWorkspaceState
  resultCount: number
  onStatusChange: (value: TaskStatusFilter) => void
  onTimeChange: (value: TaskTimeFilter) => void
  onPriorityChange: (value: TaskPriorityFilter) => void
  onClear: () => void
}) => {
  const { t } = useTranslation('tasks')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
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

  return (
    <section className={filterRegionCss} aria-label={t('workspace.filters')}>
      <button
        type="button"
        className={mobileFilterToggleCss}
        aria-expanded={mobileFiltersOpen}
        aria-controls="task-filter-controls"
        onClick={() => setMobileFiltersOpen((open) => !open)}
      >
        <span>
          <RiFilter3Line size={16} aria-hidden="true" />
          {t('workspace.filters')}
          {activeFilters.length > 0 && (
            <span className={mobileFilterCountCss}>{activeFilters.length}</span>
          )}
        </span>
        <RiArrowDownSLine
          size={18}
          aria-hidden="true"
          data-open={mobileFiltersOpen || undefined}
          className={mobileFilterChevronCss}
        />
      </button>
      <div
        id="task-filter-controls"
        className={toolbarCss}
        data-mobile-expanded={mobileFiltersOpen || undefined}
      >
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
          onSelectionChange={(key) =>
            onTimeChange(String(key) as TaskTimeFilter)
          }
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
  display: { base: 'none', sm: 'flex' },
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: '0.5rem',
  padding: '0.625rem 1rem',
  fontSize: '0.8125rem',
  '&[data-mobile-expanded]': { display: 'flex' },
  '& label': { fontSize: '0.8125rem', fontWeight: 'medium' },
  '& button': { fontSize: '0.8125rem' },
})
const mobileFilterToggleCss = css({
  width: '100%',
  minHeight: '2.75rem',
  display: { base: 'flex', sm: 'none' },
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.5rem 1rem',
  border: 0,
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.8125rem',
  fontWeight: 'medium',
  cursor: 'pointer',
  '& > span': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
  },
  _hover: { backgroundColor: 'greyscale.50' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '-2px',
  },
})
const mobileFilterCountCss = css({
  minWidth: '1.25rem',
  height: '1.25rem',
  display: 'inline-grid',
  placeItems: 'center',
  paddingX: '0.25rem',
  borderRadius: '999px',
  backgroundColor: 'primary.100',
  color: 'primary.700',
  fontSize: '0.6875rem',
  fontWeight: 'semibold',
})
const mobileFilterChevronCss = css({
  flexShrink: 0,
  transition: 'transform token(durations.fast)',
  '&[data-open]': { transform: 'rotate(180deg)' },
})
const filterSelectCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: { base: 'calc(50% - 0.25rem)', sm: '8rem' },
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
