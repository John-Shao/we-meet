import {
  useEffect,
  useLayoutEffect,
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
const FIELD_MOVE_DURATION_MS = 180
type FieldDropPosition = 'before' | 'after'

const columnOrdersEqual = (
  left: readonly TaskColumnId[],
  right: readonly TaskColumnId[]
) =>
  left.length === right.length &&
  left.every((column, index) => column === right[index])

const moveColumnBeside = (
  order: readonly TaskColumnId[],
  source: TaskColumnId,
  target: TaskColumnId,
  position: FieldDropPosition
) => {
  if (source === 'title' || source === target) return [...order]
  const remaining = order.filter((column) => column !== source)
  const targetIndex = remaining.indexOf(target)
  if (targetIndex < 0) return [...order]
  const insertionIndex =
    target === 'title'
      ? 1
      : targetIndex + (position === 'after' ? 1 : 0)
  remaining.splice(
    Math.max(1, Math.min(insertionIndex, remaining.length)),
    0,
    source
  )
  return remaining
}

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
  const columnRowsRef = useRef(new Map<TaskColumnId, HTMLDivElement>())
  const previousColumnPositionsRef = useRef(
    new Map<TaskColumnId, DOMRect>()
  )
  const movementAnimationsRef = useRef(new Map<TaskColumnId, Animation>())
  const committedColumnOrderRef = useRef<TaskColumnId[]>([])
  const dragCommittedRef = useRef(false)
  const droppedColumnTimerRef = useRef<number>()
  const [draggedColumn, setDraggedColumn] = useState<TaskColumnId>()
  const [visualColumnOrder, setVisualColumnOrder] =
    useState<TaskColumnId[]>()
  const [dropIndicator, setDropIndicator] = useState<{
    column: TaskColumnId
    position: FieldDropPosition
  }>()
  const [droppedColumn, setDroppedColumn] = useState<TaskColumnId>()
  const configuredColumns = state.columns
  const columnOrder = normalizeTaskColumnOrder(
    state.columnOrder,
    configuredColumns
  )
  const columnOrderKey = columnOrder.join(',')
  committedColumnOrderRef.current = columnOrder
  const renderedColumnOrder = visualColumnOrder ?? columnOrder
  const renderedColumnOrderKey = renderedColumnOrder.join(',')
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

  const captureColumnPositions = () => {
    previousColumnPositionsRef.current = new Map(
      [...columnRowsRef.current].map(([column, element]) => [
        column,
        element.getBoundingClientRect(),
      ])
    )
  }

  const markColumnDropped = (column: TaskColumnId) => {
    if (droppedColumnTimerRef.current) {
      window.clearTimeout(droppedColumnTimerRef.current)
    }
    setDroppedColumn(column)
    droppedColumnTimerRef.current = window.setTimeout(() => {
      setDroppedColumn(undefined)
      droppedColumnTimerRef.current = undefined
    }, FIELD_MOVE_DURATION_MS + 60)
  }

  const moveColumnToIndex = (column: TaskColumnId, targetIndex: number) => {
    if (column === 'title') return
    const next = [...columnOrder]
    const sourceIndex = next.indexOf(column)
    if (sourceIndex < 0) return
    next.splice(sourceIndex, 1)
    next.splice(Math.max(1, Math.min(targetIndex, next.length)), 0, column)
    if (columnOrdersEqual(next, columnOrder)) return
    captureColumnPositions()
    markColumnDropped(column)
    commitColumnConfiguration(configuredColumns, next)
  }

  const previewColumnDrop = (
    event: DragEvent<HTMLDivElement>,
    target: TaskColumnId
  ) => {
    event.preventDefault()
    if (!draggedColumn || draggedColumn === target) return
    event.dataTransfer.dropEffect = 'move'
    const targetElement = columnRowsRef.current.get(target)
    const targetBounds = targetElement?.getBoundingClientRect()
    const position: FieldDropPosition =
      target === 'title' ||
      (targetBounds && event.clientY >= targetBounds.top + targetBounds.height / 2)
        ? 'after'
        : 'before'
    const next = moveColumnBeside(
      renderedColumnOrder,
      draggedColumn,
      target,
      position
    )
    setDropIndicator({ column: target, position })
    if (columnOrdersEqual(next, renderedColumnOrder)) return
    captureColumnPositions()
    setVisualColumnOrder(next)
  }

  const dropColumn = (
    event: DragEvent<HTMLDivElement>,
    target: TaskColumnId
  ) => {
    event.preventDefault()
    const source =
      draggedColumn ||
      (event.dataTransfer.getData('text/plain') as TaskColumnId)
    if (!columnOrder.includes(source) || source === 'title') return
    const finalOrder = dropIndicator
      ? (visualColumnOrder ?? columnOrder)
      : moveColumnBeside(columnOrder, source, target, 'before')
    if (!columnOrdersEqual(finalOrder, renderedColumnOrder)) {
      captureColumnPositions()
      setVisualColumnOrder(finalOrder)
    }
    dragCommittedRef.current = true
    setDraggedColumn(undefined)
    setDropIndicator(undefined)
    markColumnDropped(source)
    commitColumnConfiguration(configuredColumns, finalOrder)
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

  useLayoutEffect(() => {
    const previousPositions = previousColumnPositionsRef.current
    previousColumnPositionsRef.current = new Map()
    if (
      previousPositions.size === 0 ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    columnRowsRef.current.forEach((element, column) => {
      const previous = previousPositions.get(column)
      if (!previous) return
      const deltaY = previous.top - element.getBoundingClientRect().top
      if (Math.abs(deltaY) < 1 || typeof element.animate !== 'function') return
      movementAnimationsRef.current.get(column)?.cancel()
      const animation = element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: 'translateY(0)' },
        ],
        {
          duration: FIELD_MOVE_DURATION_MS,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        }
      )
      movementAnimationsRef.current.set(column, animation)
      animation.onfinish = () => {
        if (movementAnimationsRef.current.get(column) === animation) {
          movementAnimationsRef.current.delete(column)
        }
      }
    })
  }, [renderedColumnOrderKey])

  useEffect(() => {
    setVisualColumnOrder((current) =>
      current &&
      columnOrdersEqual(current, committedColumnOrderRef.current)
        ? undefined
        : current
    )
  }, [columnOrderKey])

  useEffect(() => {
    if (
      !droppedColumn ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    const element = columnRowsRef.current.get(droppedColumn)
    if (!element || typeof element.animate !== 'function') return
    element.animate(
      [
        { scale: '0.98', boxShadow: '0 5px 14px rgba(20, 85, 180, 0.18)' },
        { scale: '1.015', boxShadow: '0 3px 10px rgba(20, 85, 180, 0.12)' },
        { scale: '1', boxShadow: '0 0 0 rgba(20, 85, 180, 0)' },
      ],
      {
        duration: FIELD_MOVE_DURATION_MS + 40,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      }
    )
  }, [droppedColumn])

  useEffect(() => {
    const movementAnimations = movementAnimationsRef.current
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
      if (droppedColumnTimerRef.current) {
        window.clearTimeout(droppedColumnTimerRef.current)
      }
      movementAnimations.forEach((animation) => animation.cancel())
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
                {renderedColumnOrder.map((column) => {
                  const checked = selectedColumns.includes(column)
                  const locked = column === 'title'
                  const label = t(`workspace.columns.${column}`)
                  return (
                    <div
                      key={column}
                      ref={(element) => {
                        if (element) columnRowsRef.current.set(column, element)
                        else columnRowsRef.current.delete(column)
                      }}
                      className={columnRowCss}
                      data-dragging={draggedColumn === column || undefined}
                      data-dropped={droppedColumn === column || undefined}
                      data-drop-position={
                        dropIndicator?.column === column
                          ? dropIndicator.position
                          : undefined
                      }
                      onDragOver={(event) => previewColumnDrop(event, column)}
                      onDrop={(event) => dropColumn(event, column)}
                    >
                      <button
                        type="button"
                        className={columnDragHandleCss}
                        aria-label={t('workspace.moveField', { field: label })}
                        disabled={column === 'title'}
                        draggable={column !== 'title'}
                        onDragStart={(event) => {
                          dragCommittedRef.current = false
                          setDraggedColumn(column)
                          setVisualColumnOrder([...columnOrder])
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', column)
                        }}
                        onDragEnd={() => {
                          setDraggedColumn(undefined)
                          setDropIndicator(undefined)
                          if (dragCommittedRef.current) {
                            dragCommittedRef.current = false
                            return
                          }
                          captureColumnPositions()
                          setVisualColumnOrder(undefined)
                        }}
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
  position: 'relative',
  minHeight: '2rem',
  display: 'grid',
  gridTemplateColumns: '1.75rem minmax(0, 1fr) 1.75rem',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.25rem',
  borderRadius: '5px',
  transition:
    'background-color 140ms ease, box-shadow 140ms ease, opacity 140ms ease, scale 140ms ease',
  willChange: 'transform',
  _hover: { backgroundColor: 'greyscale.050' },
  '&[data-dragging]': {
    backgroundColor: 'primary.50',
    boxShadow: '0 5px 14px rgba(20, 85, 180, 0.18)',
    opacity: 0.72,
    scale: '0.98',
  },
  '&[data-dropped]': {
    backgroundColor: 'primary.50',
  },
  '&[data-drop-position]::before': {
    content: '""',
    position: 'absolute',
    zIndex: 1,
    left: '0.25rem',
    right: '0.25rem',
    height: '2px',
    borderRadius: '999px',
    backgroundColor: 'primary.500',
    boxShadow: '0 0 0 1px token(colors.primary.100)',
    pointerEvents: 'none',
  },
  '&[data-drop-position="before"]::before': {
    top: '-1px',
  },
  '&[data-drop-position="after"]::before': {
    bottom: '-1px',
  },
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
    '&[data-dragging]': { scale: '1' },
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
  transition: 'color 120ms ease, scale 120ms ease',
  _active: { cursor: 'grabbing' },
  _hover: { color: 'primary.600', scale: '1.08' },
  _disabled: { color: 'greyscale.300', cursor: 'default' },
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
    _hover: { scale: '1' },
  },
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
