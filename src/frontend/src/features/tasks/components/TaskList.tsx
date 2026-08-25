import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiCheckLine,
  RiLoader4Line,
  RiMoreLine,
} from '@remixicon/react'

import { Button, Menu, MenuList } from '@/primitives'
import { VisualOnlyTooltip } from '@/primitives/VisualOnlyTooltip'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskGroup,
  TaskOrdering,
  TaskOrderingField,
  TaskStatus,
} from '../api/ApiTask'
import { usePatchTask } from '../api/fetchTasks'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskUserDisplay } from './TaskUserDisplay'

const COLUMN_WIDTHS_STORAGE_KEY = 'we-meet:task-list-column-widths:v2'

const TASK_COLUMNS = [
  { id: 'title', defaultWidth: 120, minWidth: 60, maxWidth: 360 },
  { id: 'assignee', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'priority', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'startDate', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'dueDate', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'status', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'taskList', defaultWidth: 60, minWidth: 30, maxWidth: 180 },
  { id: 'creator', defaultWidth: 60, minWidth: 30, maxWidth: 120 },
  { id: 'createdAt', defaultWidth: 80, minWidth: 40, maxWidth: 160 },
] as const

type TaskColumnId = (typeof TASK_COLUMNS)[number]['id']
type TaskColumnWidths = Record<TaskColumnId, number>

const ORDERING_BY_COLUMN: Partial<Record<TaskColumnId, TaskOrderingField>> = {
  assignee: 'assignee',
  priority: 'priority',
  startDate: 'start_date',
  dueDate: 'due_date',
  status: 'status',
  creator: 'creator',
  createdAt: 'created_at',
}

const nextOrdering = (
  current: TaskOrdering,
  field: TaskOrderingField
): TaskOrdering => {
  if (current === field) return `-${field}`
  if (current === `-${field}`) return ''
  return field
}

const defaultColumnWidths = (): TaskColumnWidths =>
  Object.fromEntries(
    TASK_COLUMNS.map((column) => [column.id, column.defaultWidth])
  ) as TaskColumnWidths

const clampColumnWidth = (columnId: TaskColumnId, value: number) => {
  const column = TASK_COLUMNS.find((candidate) => candidate.id === columnId)!
  return Math.min(column.maxWidth, Math.max(column.minWidth, value))
}

const readColumnWidths = (): TaskColumnWidths => {
  const defaults = defaultColumnWidths()
  try {
    const stored = JSON.parse(
      localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY) || '{}'
    ) as Partial<Record<TaskColumnId | 'updatedAt', unknown>>
    for (const column of TASK_COLUMNS) {
      const value =
        stored[column.id] ??
        (column.id === 'createdAt' ? stored.updatedAt : undefined)
      if (typeof value === 'number' && Number.isFinite(value)) {
        defaults[column.id] = clampColumnWidth(column.id, value)
      }
    }
  } catch {
    // A malformed or unavailable local preference falls back to defaults.
  }
  return defaults
}

const persistColumnWidths = (widths: TaskColumnWidths) => {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths))
  } catch {
    // Resizing still works for the current session in restricted storage modes.
  }
}

type ListProps = {
  tasks: ApiTask[]
  groups?: ApiTaskGroup[]
  grouped?: boolean
  ordering?: TaskOrdering
  onOrderingChange?: (ordering: TaskOrdering) => void
  selectedTaskId?: string
  onOpen: (task: ApiTask) => void
  registerRow: (taskId: string, element: HTMLElement | null) => void
  onCreateTaskInGroup?: (groupId?: string) => void
  canManageGroups?: boolean
  onRenameGroup?: (group: ApiTaskGroup) => void
  onDeleteGroup?: (group: ApiTaskGroup) => void
}

type GroupProps = Omit<ListProps, 'tasks'> & {
  task: ApiTask
  isLastInGroup?: boolean
  t: TFunction<'tasks'>
  formatDate: (value: string | null) => string
  formatDateTime: (value: string) => string
  statusOverride?: TaskStatus
  statusPending: boolean
  onToggleStatus: (task: ApiTask) => void
}

type StatusOverride = {
  status: TaskStatus
  pending: boolean
  baseUpdatedAt: string
}

export const TaskList = ({
  tasks,
  groups = [],
  grouped = false,
  ordering = '',
  onOrderingChange,
  selectedTaskId,
  onOpen,
  registerRow,
  onCreateTaskInGroup,
  canManageGroups = false,
  onRenameGroup,
  onDeleteGroup,
}: ListProps) => {
  const { t, i18n } = useTranslation('tasks')
  const patchMutation = usePatchTask()
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, StatusOverride>
  >({})
  const [statusError, setStatusError] = useState(false)
  const [columnWidths, setColumnWidths] =
    useState<TaskColumnWidths>(readColumnWidths)
  const columnWidthsRef = useRef(columnWidths)
  const [resizingColumn, setResizingColumn] = useState<TaskColumnId>()
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set()
  )
  const sections = useMemo(
    () => buildSections(tasks, groups, grouped),
    [grouped, groups, tasks]
  )
  const visibleColumns = grouped
    ? TASK_COLUMNS.filter((column) => column.id !== 'taskList')
    : TASK_COLUMNS
  const desktopColumnCount = visibleColumns.length + 1

  const toggleSection = (sectionKey: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(sectionKey)) next.delete(sectionKey)
      else next.add(sectionKey)
      return next
    })
  }

  const formatDate = (value: string | null) => {
    if (!value) return '—'
    const [year, month, day] = value.split('-').map(Number)
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(year, month - 1, day))
  }
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value))

  const moveToGroup = (taskId: string, groupId?: string) => {
    patchMutation.mutate({
      taskId,
      patch: { group_id: groupId || null },
    })
  }

  useEffect(() => {
    setStatusOverrides((current) => {
      let changed = false
      const next = { ...current }
      const visibleTaskIds = new Set(tasks.map((task) => task.id))
      for (const [taskId, override] of Object.entries(next)) {
        if (!override.pending && !visibleTaskIds.has(taskId)) {
          delete next[taskId]
          changed = true
        }
      }
      for (const task of tasks) {
        const override = next[task.id]
        if (
          override &&
          !override.pending &&
          (task.status === override.status ||
            task.updated_at !== override.baseUpdatedAt)
        ) {
          delete next[task.id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [statusOverrides, tasks])

  const toggleTaskStatus = async (task: ApiTask) => {
    const currentOverride = statusOverrides[task.id]
    if (!task.can_update_status || currentOverride?.pending) return

    const currentStatus = currentOverride?.status ?? task.status
    const status: TaskStatus =
      currentStatus === 'completed' ? 'todo' : 'completed'
    setStatusError(false)
    setStatusOverrides((current) => ({
      ...current,
      [task.id]: {
        status,
        pending: true,
        baseUpdatedAt: task.updated_at,
      },
    }))

    try {
      await patchMutation.mutateAsync({ taskId: task.id, patch: { status } })
      setStatusOverrides((current) => ({
        ...current,
        [task.id]: { ...current[task.id], pending: false },
      }))
    } catch {
      setStatusOverrides((current) => {
        const next = { ...current }
        delete next[task.id]
        return next
      })
      setStatusError(true)
    }
  }

  const setColumnWidth = (columnId: TaskColumnId, value: number) => {
    const next = {
      ...columnWidthsRef.current,
      [columnId]: clampColumnWidth(columnId, value),
    }
    columnWidthsRef.current = next
    setColumnWidths(next)
  }

  const beginColumnResize = (
    columnId: TaskColumnId,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault()
    const originX = event.clientX
    const originWidth = columnWidthsRef.current[columnId]
    setResizingColumn(columnId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (pointer: PointerEvent) => {
      setColumnWidth(columnId, originWidth + pointer.clientX - originX)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setResizingColumn(undefined)
      persistColumnWidths(columnWidthsRef.current)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resizeColumnWithKeyboard = (
    columnId: TaskColumnId,
    event: KeyboardEvent<HTMLButtonElement>
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setColumnWidth(
      columnId,
      columnWidthsRef.current[columnId] + (event.key === 'ArrowLeft' ? -16 : 16)
    )
    persistColumnWidths(columnWidthsRef.current)
  }

  const resetColumnWidth = (columnId: TaskColumnId) => {
    const column = TASK_COLUMNS.find((candidate) => candidate.id === columnId)!
    setColumnWidth(columnId, column.defaultWidth)
    persistColumnWidths(columnWidthsRef.current)
  }

  const groupProps = {
    grouped,
    selectedTaskId,
    onOpen,
    registerRow,
    t,
    formatDate,
    formatDateTime,
    onToggleStatus: (task: ApiTask) => void toggleTaskStatus(task),
  }

  return (
    <>
      {statusError && (
        <p role="alert" className={statusErrorCss}>
          {t('error')}
        </p>
      )}
      <table className={tableCss} data-grouped={grouped || undefined}>
        <thead>
          <tr>
            {visibleColumns.map((column) => {
              const label = t(`workspace.columns.${column.id}`)
              const orderingField = ORDERING_BY_COLUMN[column.id]
              const sortDirection =
                ordering === orderingField
                  ? 'ascending'
                  : orderingField && ordering === `-${orderingField}`
                    ? 'descending'
                    : undefined
              return (
                <th
                  key={column.id}
                  data-column={column.id}
                  className={columnClassName(column.id)}
                  style={{ width: columnWidths[column.id] }}
                  aria-sort={
                    orderingField && onOrderingChange
                      ? sortDirection || 'none'
                      : undefined
                  }
                >
                  {orderingField && onOrderingChange ? (
                    <button
                      type="button"
                      className={columnSortButtonCss}
                      onClick={() =>
                        onOrderingChange(nextOrdering(ordering, orderingField))
                      }
                    >
                      <span>{label}</span>
                      {sortDirection === 'ascending' && (
                        <RiArrowUpSLine aria-hidden="true" size={16} />
                      )}
                      {sortDirection === 'descending' && (
                        <RiArrowDownSLine aria-hidden="true" size={16} />
                      )}
                    </button>
                  ) : (
                    label
                  )}
                  <button
                    type="button"
                    role="slider"
                    aria-label={t('workspace.resizeColumn', { column: label })}
                    aria-orientation="horizontal"
                    aria-valuemin={column.minWidth}
                    aria-valuemax={column.maxWidth}
                    aria-valuenow={columnWidths[column.id]}
                    data-resizing={resizingColumn === column.id || undefined}
                    className={columnResizeHandleCss}
                    onPointerDown={(event) =>
                      beginColumnResize(column.id, event)
                    }
                    onKeyDown={(event) =>
                      resizeColumnWithKeyboard(column.id, event)
                    }
                    onDoubleClick={() => resetColumnWidth(column.id)}
                  >
                    <span aria-hidden="true" className={columnResizeGripCss} />
                  </button>
                </th>
              )
            })}
            <th
              aria-hidden="true"
              className={tableGutterCellCss}
              style={{ width: 8 }}
            />
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const collapsed = collapsedSections.has(section.key)
            return (
              <Fragment key={section.key}>
                {grouped && (
                  <DesktopGroupHeader
                    section={section}
                    collapsed={collapsed}
                    onToggle={() => toggleSection(section.key)}
                    onCreateTask={onCreateTaskInGroup}
                    canManageGroups={canManageGroups}
                    onRenameGroup={onRenameGroup}
                    onDeleteGroup={onDeleteGroup}
                    onMoveTask={moveToGroup}
                    columnCount={desktopColumnCount}
                  />
                )}
                {!collapsed && section.tasks.length === 0 && (
                  <DesktopEmptyGroupRow
                    section={section}
                    columnCount={desktopColumnCount}
                    canCreateTask={Boolean(onCreateTaskInGroup)}
                    onMoveTask={moveToGroup}
                  />
                )}
                {!collapsed &&
                  section.tasks.map((task, taskIndex) => (
                    <DesktopTaskGroup
                      key={task.id}
                      task={task}
                      isLastInGroup={taskIndex === section.tasks.length - 1}
                      statusOverride={statusOverrides[task.id]?.status}
                      statusPending={Boolean(statusOverrides[task.id]?.pending)}
                      {...groupProps}
                    />
                  ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <ul className={mobileListCss}>
        {sections.map((section) => {
          const collapsed = collapsedSections.has(section.key)
          return (
            <li key={section.key} className={mobileSectionCss}>
              {grouped && (
                <MobileGroupHeader
                  section={section}
                  collapsed={collapsed}
                  onToggle={() => toggleSection(section.key)}
                  onCreateTask={onCreateTaskInGroup}
                  canManageGroups={canManageGroups}
                  onRenameGroup={onRenameGroup}
                  onDeleteGroup={onDeleteGroup}
                  onMoveTask={moveToGroup}
                />
              )}
              {!collapsed && (
                <ul
                  className={mobileSectionTasksCss}
                  data-grouped={grouped || undefined}
                >
                  {section.tasks.length === 0 && (
                    <MobileEmptyGroup
                      section={section}
                      canCreateTask={Boolean(onCreateTaskInGroup)}
                      onMoveTask={moveToGroup}
                    />
                  )}
                  {section.tasks.map((task) => (
                    <MobileTaskGroup
                      key={task.id}
                      task={task}
                      statusOverride={statusOverrides[task.id]?.status}
                      statusPending={Boolean(statusOverrides[task.id]?.pending)}
                      {...groupProps}
                    />
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

const DesktopTaskGroup = (props: GroupProps) => <DesktopTaskRow {...props} />

const DesktopTaskRow = ({
  task,
  grouped,
  isLastInGroup,
  selectedTaskId,
  onOpen,
  registerRow,
  t,
  formatDate,
  formatDateTime,
  statusOverride,
  statusPending,
  onToggleStatus,
}: GroupProps) => (
  <tr
    ref={(element) => registerRow(task.id, element)}
    tabIndex={0}
    aria-label={t('workspace.openTask', { title: task.title })}
    data-selected={selectedTaskId === task.id || undefined}
    data-grouped={grouped || undefined}
    data-group-last={grouped && isLastInGroup ? true : undefined}
    className={rowCss}
    draggable={task.can_edit}
    onDragStart={(event) => startTaskDrag(event, task)}
    onClick={() => onOpen(task)}
    onKeyDown={(event) => openOnEnter(event, task, onOpen)}
  >
    <td
      className={grouped ? groupedTaskTitleCellCss : undefined}
      data-group-last={grouped && isLastInGroup ? true : undefined}
    >
      <div className={taskTitleContentCss}>
        <TaskStatusButton
          task={task}
          status={statusOverride ?? task.status}
          pending={statusPending}
          onToggle={onToggleStatus}
        />
        <TaskTitle task={task} />
      </div>
    </td>
    <td>
      <TaskUserDisplay user={task.assignee} />
    </td>
    <td>
      <TaskPriorityBadge priority={task.priority} />
    </td>
    <td className={secondaryColumnCss}>{formatDate(task.start_date)}</td>
    <td
      data-overdue={task.time_state === 'overdue' || undefined}
      className={dueDateCss}
    >
      {formatDate(task.due_date)}
    </td>
    <td>{t(`statuses.${statusOverride ?? task.status}`)}</td>
    {!grouped && (
      <td className={secondaryColumnCss}>
        {task.task_list?.name || t('taskLists.standalone')}
      </td>
    )}
    <td className={secondaryColumnCss}>
      <TaskUserDisplay user={task.creator} />
    </td>
    <td className={wideColumnCss}>{formatDateTime(task.created_at)}</td>
    <td aria-hidden="true" className={tableGutterCellCss} />
  </tr>
)

const MobileTaskGroup = (props: GroupProps) => {
  return (
    <li>
      <MobileTaskCard {...props} />
    </li>
  )
}

const MobileTaskCard = ({
  task,
  selectedTaskId,
  onOpen,
  registerRow,
  t,
  formatDate,
  statusOverride,
  statusPending,
  onToggleStatus,
}: GroupProps) => (
  <div
    ref={(element) => registerRow(task.id, element)}
    tabIndex={0}
    role="button"
    aria-label={t('workspace.openTask', { title: task.title })}
    data-selected={selectedTaskId === task.id || undefined}
    className={mobileCardCss}
    draggable={task.can_edit}
    onDragStart={(event) => startTaskDrag(event, task)}
    onClick={() => onOpen(task)}
    onKeyDown={(event) => openOnEnter(event, task, onOpen)}
  >
    <div className={mobileTitleRowCss}>
      <TaskStatusButton
        task={task}
        status={statusOverride ?? task.status}
        pending={statusPending}
        onToggle={onToggleStatus}
      />
      <TaskTitle task={task} />
      <TaskPriorityBadge priority={task.priority} />
    </div>
    <dl className={mobileMetaCss}>
      <div>
        <dt>{t('workspace.columns.status')}</dt>
        <dd>{t(`statuses.${statusOverride ?? task.status}`)}</dd>
      </div>
      <div>
        <dt>{t('workspace.columns.assignee')}</dt>
        <dd>
          <TaskUserDisplay user={task.assignee} />
        </dd>
      </div>
      <div>
        <dt>{t('workspace.columns.dueDate')}</dt>
        <dd data-overdue={task.time_state === 'overdue' || undefined}>
          {formatDate(task.due_date)}
        </dd>
      </div>
    </dl>
  </div>
)

const TaskStatusButton = ({
  task,
  status,
  pending,
  onToggle,
}: {
  task: ApiTask
  status: TaskStatus
  pending: boolean
  onToggle: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('tasks')
  const targetStatus = status === 'completed' ? 'todo' : 'completed'
  const actionLabel = t(`actions.to_${targetStatus}`)
  const accessibleLabel = task.can_update_status
    ? t(
        status === 'completed'
          ? 'workspace.quickReopen'
          : 'workspace.quickComplete',
        { title: task.title }
      )
    : `${t(`statuses.${status}`)}: ${task.title}`

  return (
    <div className={taskStatusControlCss}>
      <VisualOnlyTooltip
        tooltip={task.can_update_status ? actionLabel : t(`statuses.${status}`)}
        ariaLabel={accessibleLabel}
      >
        <button
          type="button"
          className={taskStatusButtonCss}
          data-status={status}
          data-pending={pending || undefined}
          aria-busy={pending || undefined}
          disabled={!task.can_update_status || pending}
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(task)
          }}
        >
          {pending ? (
            <RiLoader4Line aria-hidden="true" size={12} />
          ) : (
            status === 'completed' && (
              <RiCheckLine aria-hidden="true" size={10} />
            )
          )}
        </button>
      </VisualOnlyTooltip>
    </div>
  )
}

const TaskTitle = ({ task }: { task: ApiTask }) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={titleCellCss}>
      <div className={titleLineCss}>
        <strong>{task.title}</strong>
      </div>
      {task.source_room_name && (
        <span className={titleMetaCss}>
          {t('sourceMeeting', { name: task.source_room_name })}
        </span>
      )}
    </div>
  )
}

const openOnEnter = (
  event: KeyboardEvent<HTMLElement>,
  task: ApiTask,
  onOpen: (task: ApiTask) => void
) => {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter') {
    event.preventDefault()
    onOpen(task)
  }
}

type TaskSection = {
  key: string
  group?: ApiTaskGroup
  name: string
  tasks: ApiTask[]
}

const buildSections = (
  tasks: ApiTask[],
  groups: ApiTaskGroup[],
  grouped: boolean
): TaskSection[] => {
  if (!grouped) return [{ key: 'all', name: '', tasks }]
  const knownGroupIds = new Set(groups.map((group) => group.id))
  const sections: TaskSection[] = [...groups]
    .sort((left, right) =>
      left.sort_order === right.sort_order
        ? left.created_at.localeCompare(right.created_at)
        : left.sort_order - right.sort_order
    )
    .map((group) => ({
      key: group.id,
      group,
      name: group.name,
      tasks: tasks.filter((task) => task.group?.id === group.id),
    }))
  const ungrouped = tasks.filter(
    (task) => !task.group || !knownGroupIds.has(task.group.id)
  )
  if (ungrouped.length > 0 || groups.length === 0) {
    sections.push({ key: 'ungrouped', name: '', tasks: ungrouped })
  }
  return sections
}

const DesktopGroupHeader = ({
  section,
  collapsed,
  onToggle,
  onCreateTask,
  canManageGroups,
  onRenameGroup,
  onDeleteGroup,
  onMoveTask,
  columnCount,
}: {
  section: TaskSection
  collapsed: boolean
  onToggle: () => void
  onCreateTask?: (groupId?: string) => void
  canManageGroups: boolean
  onRenameGroup?: (group: ApiTaskGroup) => void
  onDeleteGroup?: (group: ApiTaskGroup) => void
  onMoveTask: (taskId: string, groupId?: string) => void
  columnCount: number
}) => {
  const { t } = useTranslation('tasks')
  return (
    <tr
      className={groupHeaderRowCss}
      onDragOver={markTaskDropTarget}
      onDragLeave={leaveTaskDropTarget}
      onDrop={(event) => dropTask(event, section.group?.id, onMoveTask)}
    >
      <td colSpan={columnCount}>
        <div className={groupHeaderCss}>
          <button
            type="button"
            className={expandButtonCss}
            aria-label={t(collapsed ? 'groups.expand' : 'groups.collapse')}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            {collapsed ? (
              <RiArrowRightSLine size={16} />
            ) : (
              <RiArrowDownSLine size={16} />
            )}
          </button>
          <strong>{section.name || t('groups.ungrouped')}</strong>
          <span>{t('groups.taskCount', { count: section.tasks.length })}</span>
          <div className={groupActionsCss} data-group-actions>
            {onCreateTask && (
              <button
                type="button"
                className={groupCreateTaskCss}
                onClick={() => onCreateTask(section.group?.id)}
              >
                + {t('groups.addTask')}
              </button>
            )}
            {canManageGroups &&
              section.group &&
              onRenameGroup &&
              onDeleteGroup && (
                <GroupMoreMenu
                  group={section.group}
                  onRename={onRenameGroup}
                  onDelete={onDeleteGroup}
                />
              )}
          </div>
        </div>
      </td>
    </tr>
  )
}

const MobileGroupHeader = ({
  section,
  collapsed,
  onToggle,
  onCreateTask,
  canManageGroups,
  onRenameGroup,
  onDeleteGroup,
  onMoveTask,
}: {
  section: TaskSection
  collapsed: boolean
  onToggle: () => void
  onCreateTask?: (groupId?: string) => void
  canManageGroups: boolean
  onRenameGroup?: (group: ApiTaskGroup) => void
  onDeleteGroup?: (group: ApiTaskGroup) => void
  onMoveTask: (taskId: string, groupId?: string) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <div
      className={mobileGroupHeaderCss}
      onDragOver={markTaskDropTarget}
      onDragLeave={leaveTaskDropTarget}
      onDrop={(event) => dropTask(event, section.group?.id, onMoveTask)}
    >
      <button
        type="button"
        className={expandButtonCss}
        aria-label={t(collapsed ? 'groups.expand' : 'groups.collapse')}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? (
          <RiArrowRightSLine size={16} />
        ) : (
          <RiArrowDownSLine size={16} />
        )}
      </button>
      <strong>{section.name || t('groups.ungrouped')}</strong>
      <span>{t('groups.taskCount', { count: section.tasks.length })}</span>
      <div className={groupActionsCss}>
        {onCreateTask && (
          <button
            type="button"
            className={groupCreateTaskCss}
            onClick={() => onCreateTask(section.group?.id)}
          >
            + {t('groups.addTask')}
          </button>
        )}
        {canManageGroups && section.group && onRenameGroup && onDeleteGroup && (
          <GroupMoreMenu
            group={section.group}
            onRename={onRenameGroup}
            onDelete={onDeleteGroup}
          />
        )}
      </div>
    </div>
  )
}

const DesktopEmptyGroupRow = ({
  section,
  columnCount,
  canCreateTask,
  onMoveTask,
}: {
  section: TaskSection
  columnCount: number
  canCreateTask: boolean
  onMoveTask: (taskId: string, groupId?: string) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <tr
      className={emptyGroupRowCss}
      onDragOver={markTaskDropTarget}
      onDragLeave={leaveTaskDropTarget}
      onDrop={(event) => dropTask(event, section.group?.id, onMoveTask)}
    >
      <td colSpan={columnCount}>
        {t(canCreateTask ? 'groups.empty' : 'groups.emptyReadOnly')}
      </td>
    </tr>
  )
}

const MobileEmptyGroup = ({
  section,
  canCreateTask,
  onMoveTask,
}: {
  section: TaskSection
  canCreateTask: boolean
  onMoveTask: (taskId: string, groupId?: string) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <li
      className={mobileEmptyGroupCss}
      onDragOver={markTaskDropTarget}
      onDragLeave={leaveTaskDropTarget}
      onDrop={(event) => dropTask(event, section.group?.id, onMoveTask)}
    >
      {t(canCreateTask ? 'groups.empty' : 'groups.emptyReadOnly')}
    </li>
  )
}

const GroupMoreMenu = ({
  group,
  onRename,
  onDelete,
}: {
  group: ApiTaskGroup
  onRename: (group: ApiTaskGroup) => void
  onDelete: (group: ApiTaskGroup) => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <Menu placement="bottom">
      <Button
        aria-label={t('groups.more')}
        className={groupMoreButtonCss}
        size="icon24"
        variant="quaternaryText"
      >
        <RiMoreLine size={16} />
      </Button>
      <MenuList
        aria-label={t('groups.more')}
        menuClassName={groupMoreMenuCss}
        items={[
          { value: 'rename', label: t('groups.rename') },
          {
            value: 'delete',
            label: t('groups.delete'),
            isDisabled: !group.can_delete,
          },
        ]}
        onAction={(action) => {
          if (action === 'rename') onRename(group)
          if (action === 'delete') onDelete(group)
        }}
      />
    </Menu>
  )
}

const startTaskDrag = (event: DragEvent<HTMLElement>, task: ApiTask) => {
  if (!task.can_edit) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-we-meet-task', task.id)
}

const markTaskDropTarget = (event: DragEvent<HTMLElement>) => {
  event.preventDefault()
  event.currentTarget.setAttribute('data-drag-over', 'true')
}

const leaveTaskDropTarget = (event: DragEvent<HTMLElement>) => {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
    return
  }
  event.currentTarget.removeAttribute('data-drag-over')
}

const dropTask = (
  event: DragEvent<HTMLElement>,
  groupId: string | undefined,
  onMoveTask: (taskId: string, groupId?: string) => void
) => {
  event.preventDefault()
  event.currentTarget.removeAttribute('data-drag-over')
  const taskId = event.dataTransfer.getData('application/x-we-meet-task')
  if (taskId) onMoveTask(taskId, groupId)
}

const columnClassName = (columnId: TaskColumnId) => {
  if (
    columnId === 'startDate' ||
    columnId === 'taskList' ||
    columnId === 'creator'
  ) {
    return secondaryColumnCss
  }
  if (columnId === 'createdAt') return wideColumnCss
  return undefined
}

const tableCss = css({
  display: { base: 'none', md: 'table' },
  width: {
    md: 'max(100%, 328px)',
    lg: 'max(100%, 448px)',
    xl: 'max(100%, 528px)',
  },
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
  color: 'default.text',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid token(colors.greyscale.200)',
    backgroundColor: 'greyscale.50',
    color: 'default.subtle-text',
    fontSize: '0.75rem',
    fontWeight: '500',
    textAlign: 'left',
  },
  '& th:hover > [role="slider"]': { opacity: 1 },
  '& td': {
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid token(colors.greyscale.200)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
  },
})
const tableGutterCellCss = css({
  width: '0.5rem',
  minWidth: '0.5rem',
  padding: '0!important',
  pointerEvents: 'none',
})
const columnSortButtonCss = css({
  maxWidth: 'calc(100% - 0.5rem)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.125rem',
  padding: 0,
  border: 0,
  backgroundColor: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontWeight: 'inherit',
  cursor: 'pointer',
  '& span': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '& svg': { flexShrink: 0 },
  _hover: { color: 'primary.600' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '2px',
  },
})
const columnResizeHandleCss = css({
  position: 'absolute',
  top: 0,
  // Keep both rails inside the table cell. Collapsed table borders can clip
  // content that straddles the next column, making the outer rail disappear.
  right: 0,
  width: '0.5rem',
  height: '100%',
  zIndex: 2,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'col-resize',
  touchAction: 'none',
  padding: 0,
  border: 0,
  backgroundColor: 'transparent',
  color: 'greyscale.400',
  outline: 'none',
  opacity: 0,
  transition: 'opacity token(durations.fast), color token(durations.fast)',
  _hover: { color: 'primary.500' },
  _focusVisible: {
    opacity: 1,
    color: 'primary.500',
  },
  '&[data-resizing]': {
    opacity: 1,
    color: 'primary.500',
  },
})
const columnResizeGripCss = css({
  width: '6px',
  height: '0.875rem',
  flexShrink: 0,
  backgroundImage:
    'linear-gradient(to right, currentColor 0 2px, transparent 2px 4px, currentColor 4px 6px)',
  backgroundRepeat: 'no-repeat',
})
const rowCss = css({
  cursor: 'pointer',
  outline: 'none',
  transition: 'background-color token(durations.fast)',
  _hover: { backgroundColor: 'greyscale.50' },
  _focusVisible: { boxShadow: 'inset 0 0 0 2px token(colors.primary.500)' },
  '&[data-selected]': { backgroundColor: 'selected.bg' },
})
const groupHeaderRowCss = css({
  '& td': {
    padding: '0.25rem 0.75rem!important',
    borderTop: '0.5rem solid token(colors.greyscale.000)!important',
    borderBottom: '1px solid token(colors.greyscale.200)!important',
    backgroundColor: 'greyscale.000',
    overflow: 'visible!important',
    transition: 'background-color token(durations.fast)',
  },
  '& [data-group-actions]': {
    opacity: 0,
    visibility: 'hidden',
    pointerEvents: 'none',
    transition: 'opacity token(durations.fast)',
  },
  '&:hover td, &:focus-within td': {
    backgroundColor: 'greyscale.50',
  },
  '&:hover [data-group-actions], &:focus-within [data-group-actions]': {
    opacity: 1,
    visibility: 'visible',
    pointerEvents: 'auto',
  },
  '&[data-drag-over] td': {
    backgroundColor: 'selected.bg',
    boxShadow: 'inset 3px 0 0 token(colors.primary.500)',
  },
})
const groupHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2rem',
  color: 'greyscale.700',
  '& strong': { fontSize: '0.875rem', fontWeight: '600' },
  '& > span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const groupActionsCss = css({
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.125rem',
  flexShrink: 0,
})
const groupCreateTaskCss = css({
  padding: '0.25rem 0.5rem',
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'primary.600',
  fontSize: '0.75rem',
  lineHeight: '1rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
const groupMoreMenuCss = css({
  '& [role="menuitem"]': {
    paddingY: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
  '& [role="menuitem"][data-disabled]': {
    color: 'greyscale.400!',
    cursor: 'default',
  },
})
const groupMoreButtonCss = css({
  marginLeft: '0!',
  color: 'primary.600!',
  flexShrink: 0,
  '&[data-hovered], &[data-pressed]': { color: 'primary.600!' },
})
const groupedTaskTitleCellCss = css({
  position: 'relative',
  paddingLeft: '3.25rem!important',
  overflow: 'visible!important',
  '&::before': {
    content: '""',
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '2.5rem',
    width: '1px',
    backgroundColor: 'greyscale.200',
  },
  '&::after': {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '2.5rem',
    width: '0.75rem',
    height: '1px',
    backgroundColor: 'greyscale.200',
  },
  '&[data-group-last]::before': { bottom: '50%' },
})
const taskTitleContentCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})
const taskStatusControlCss = css({
  flexShrink: 0,
  '& > div': { display: 'flex' },
})
const taskStatusButtonCss = css({
  width: '0.875rem',
  height: '0.875rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.000',
  cursor: 'pointer',
  transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
  '&:not(:disabled):hover': {
    borderColor: 'primary.500',
    boxShadow: '0 0 0 2px token(colors.primary.100)',
  },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '2px',
  },
  _disabled: { cursor: 'default', pointerEvents: 'none' },
  '&[data-status="completed"]': {
    borderColor: 'success.500',
    backgroundColor: 'success.500',
    '&:not(:disabled):hover': {
      borderColor: 'success.600',
      backgroundColor: 'success.600',
      boxShadow: '0 0 0 2px token(colors.success.100)',
    },
  },
  '&[data-pending] svg': {
    animation: 'rotate 700ms linear infinite',
  },
})
const statusErrorCss = css({
  margin: 0,
  padding: '0.5rem 1rem',
  borderBottom: '1px solid token(colors.danger.200)',
  backgroundColor: 'danger.50',
  color: 'danger.700',
  fontSize: '0.75rem',
})
const emptyGroupRowCss = css({
  '& td': {
    height: '2.75rem',
    padding: '0.5rem 1rem 0.5rem 4rem!important',
    borderBottom: '1px solid token(colors.greyscale.200)!important',
    backgroundColor: 'greyscale.000',
    color: 'default.subtle-text',
    fontSize: '0.75rem',
  },
  '&[data-drag-over] td': {
    backgroundColor: 'selected.bg',
    color: 'primary.700',
    boxShadow: 'inset 3px 0 0 token(colors.primary.500)',
  },
})
const secondaryColumnCss = css({ display: { md: 'none', lg: 'table-cell' } })
const wideColumnCss = css({ display: { md: 'none', xl: 'table-cell' } })
const titleCellCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  overflow: 'hidden',
})
const titleLineCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  '& strong': { overflow: 'hidden', textOverflow: 'ellipsis' },
})
const expandButtonCss = css({
  width: '1.25rem',
  height: '1.25rem',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '4px',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.200' },
})
const titleMetaCss = css({
  overflow: 'hidden',
  color: 'default.subtle-text',
  fontSize: '0.6875rem',
  textOverflow: 'ellipsis',
})
const dueDateCss = css({
  '&[data-overdue]': { color: 'danger.600', fontWeight: '600' },
})
const mobileListCss = css({
  display: { base: 'flex', md: 'none' },
  flexDirection: 'column',
  gap: '0.625rem',
  listStyle: 'none',
  margin: 0,
  padding: '0.75rem',
})
const mobileSectionCss = css({ listStyle: 'none' })
const mobileSectionTasksCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  '&[data-grouped]': {
    marginLeft: '1.25rem',
    paddingLeft: '0.75rem',
    borderLeft: '1px solid token(colors.greyscale.200)',
  },
})
const mobileGroupHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2.5rem',
  paddingX: '0.5rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.50',
  '& strong': { fontSize: '0.875rem' },
  '& > span': { color: 'greyscale.500', fontSize: '0.75rem' },
  '&[data-drag-over]': {
    borderColor: 'primary.500',
    backgroundColor: 'selected.bg',
  },
})
const mobileEmptyGroupCss = css({
  padding: '0.75rem',
  border: '1px dashed token(colors.greyscale.300)',
  borderRadius: '6px',
  color: 'default.subtle-text',
  fontSize: '0.75rem',
  listStyle: 'none',
  '&[data-drag-over]': {
    borderColor: 'primary.500',
    backgroundColor: 'selected.bg',
    color: 'primary.700',
  },
})
const mobileCardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '0.875rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  cursor: 'pointer',
  outline: 'none',
  '&[data-selected]': {
    borderColor: 'selected.accent',
    backgroundColor: 'selected.bg',
  },
  _focusVisible: { boxShadow: '0 0 0 2px token(colors.primary.400)' },
})
const mobileTitleRowCss = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '0.625rem',
})
const mobileMetaCss = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.75rem',
  margin: 0,
  '& dt': { color: 'default.subtle-text', fontSize: '0.6875rem' },
  '& dd': { margin: 0, fontSize: '0.8125rem' },
  '& dd[data-overdue]': { color: 'danger.600', fontWeight: '600' },
})
