import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiCloseLine,
  RiDraggable,
  RiEyeLine,
  RiEyeOffLine,
  RiFilter3Line,
  RiLockLine,
} from '@remixicon/react'

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
import {
  defaultTaskColumnsForState,
  effectiveTaskColumns,
  DEFAULT_TASK_COLUMN_ORDER,
  normalizeTaskColumnOrder,
  type TaskWorkspaceState,
} from '../taskWorkspaceState'

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
  onColumnsChange: (value: TaskColumnId[], order?: TaskColumnId[]) => void
  statusLocked?: boolean
  onClear: () => void
}) => {
  const { t } = useTranslation('tasks')
  const columnPickerRef = useRef<HTMLDetailsElement>(null)
  const [draggedColumn, setDraggedColumn] = useState<TaskColumnId>()
  const configuredColumns = state.columns
  const columnOrder = normalizeTaskColumnOrder(
    state.columnOrder,
    configuredColumns
  )
  const selectedColumns = effectiveTaskColumns({
    ...state,
    columns: configuredColumns,
  })
  const defaultColumns = defaultTaskColumnsForState(state)
  const columnsAreDefault =
    configuredColumns.length === defaultColumns.length &&
    configuredColumns.every(
      (column, index) => column === defaultColumns[index]
    ) &&
    columnOrder.every(
      (column, index) => column === DEFAULT_TASK_COLUMN_ORDER[index]
    )
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

  const commitColumnConfiguration = (
    columns: TaskColumnId[],
    order = columnOrder
  ) => {
    const position = new Map(order.map((column, index) => [column, index]))
    onColumnsChange(
      [...columns].sort(
        (left, right) => position.get(left)! - position.get(right)!
      ),
      order
    )
  }

  const moveColumnToIndex = (column: TaskColumnId, targetIndex: number) => {
    if (column === 'title') return
    const next = [...columnOrder]
    const sourceIndex = next.indexOf(column)
    if (sourceIndex < 0) return
    next.splice(sourceIndex, 1)
    next.splice(Math.max(1, Math.min(targetIndex, next.length)), 0, column)
    commitColumnConfiguration(configuredColumns, next)
  }

  const dropColumn = (
    event: DragEvent<HTMLDivElement>,
    target: TaskColumnId
  ) => {
    event.preventDefault()
    const source =
      draggedColumn ||
      (event.dataTransfer.getData('text/plain') as TaskColumnId)
    if (!columnOrder.includes(source) || source === target) return
    const targetIndex = columnOrder.indexOf(target)
    moveColumnToIndex(source, target === 'title' ? 1 : targetIndex)
    setDraggedColumn(undefined)
  }

  const moveColumnWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    column: TaskColumnId
  ) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const offset = event.key === 'ArrowUp' ? -1 : 1
    moveColumnToIndex(column, columnOrder.indexOf(column) + offset)
  }

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
        <div className={displaySettingsCss}>
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
              <div className={columnPickerActionsCss}>
                <button
                  type="button"
                  disabled={columnsAreDefault}
                  onClick={() =>
                    onColumnsChange(defaultColumns, [
                      ...DEFAULT_TASK_COLUMN_ORDER,
                    ])
                  }
                >
                  {t('workspace.resetFields')}
                </button>
              </div>
              <div className={columnListCss}>
                {columnOrder.map((column) => {
                  const checked = selectedColumns.includes(column)
                  const locked =
                    column === 'title' ||
                    (state.scope === 'created' && column === 'creator') ||
                    (state.taskList !== 'all' && column === 'taskList') ||
                    (state.status === 'completed' && column === 'completedAt')
                  const label = t(`workspace.columns.${column}`)
                  return (
                    <div
                      key={column}
                      className={columnRowCss}
                      data-dragging={draggedColumn === column || undefined}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => dropColumn(event, column)}
                    >
                      <button
                        type="button"
                        className={columnDragHandleCss}
                        aria-label={t('workspace.moveField', { field: label })}
                        disabled={column === 'title'}
                        draggable={column !== 'title'}
                        onDragStart={(event) => {
                          setDraggedColumn(column)
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', column)
                        }}
                        onDragEnd={() => setDraggedColumn(undefined)}
                        onKeyDown={(event) =>
                          moveColumnWithKeyboard(event, column)
                        }
                      >
                        <RiDraggable size={16} aria-hidden="true" />
                      </button>
                      <span className={columnLabelCss}>{label}</span>
                      <button
                        type="button"
                        className={columnVisibilityButtonCss}
                        disabled={locked}
                        aria-label={t(
                          locked
                            ? 'workspace.fieldLocked'
                            : checked
                              ? 'workspace.hideField'
                              : 'workspace.showField',
                          { field: label }
                        )}
                        onClick={() =>
                          commitColumnConfiguration(
                            checked
                              ? configuredColumns.filter(
                                  (item) => item !== column
                                )
                              : [...configuredColumns, column]
                          )
                        }
                      >
                        {locked ? (
                          <RiLockLine size={16} aria-hidden="true" />
                        ) : checked ? (
                          <RiEyeLine size={16} aria-hidden="true" />
                        ) : (
                          <RiEyeOffLine size={16} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </details>
        </div>
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
const displaySettingsCss = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginLeft: 'auto',
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
    // Keep the picker above the task table's sticky column headers. `dropdown`
    // is not a defined project z-index token and was therefore ignored by the
    // browser, leaving the sticky headers (z-index: 1) on top of this panel.
    zIndex: 'docked',
    top: 'calc(100% + 0.25rem)',
    right: 0,
    minWidth: '15rem',
    display: 'grid',
    gap: '0.5rem',
    padding: '0.75rem',
    border: '1px solid token(colors.greyscale.200)',
    borderRadius: '8px',
    backgroundColor: 'greyscale.000',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
  },
})
const columnPickerActionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  paddingBottom: '0.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& button': {
    padding: 0,
    border: 0,
    background: 'transparent',
    color: 'primary.700',
    cursor: 'pointer',
    _hover: { textDecoration: 'underline' },
    _disabled: {
      color: 'greyscale.400',
      cursor: 'default',
      textDecoration: 'none',
    },
  },
})
const columnListCss = css({
  display: 'grid',
  gap: '0.125rem',
})
const columnRowCss = css({
  minHeight: '2rem',
  display: 'grid',
  gridTemplateColumns: '1.75rem minmax(0, 1fr) 1.75rem',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.25rem',
  borderRadius: '5px',
  _hover: { backgroundColor: 'greyscale.050' },
  '&[data-dragging]': {
    backgroundColor: 'primary.50',
    opacity: 0.7,
  },
})
const columnDragHandleCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'greyscale.500',
  cursor: 'grab',
  _active: { cursor: 'grabbing' },
  _disabled: { color: 'greyscale.300', cursor: 'default' },
})
const columnLabelCss = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const columnVisibilityButtonCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
  _disabled: { color: 'greyscale.400', cursor: 'default' },
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
