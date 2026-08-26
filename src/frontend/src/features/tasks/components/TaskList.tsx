import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiCalendarLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiLoader4Line,
  RiMoreLine,
  RiShareForwardLine,
} from '@remixicon/react'

import { ContactPicker, type DirectoryMember } from '@/features/contacts'
import { Button, Menu, MenuList } from '@/primitives'
import { Select } from '@/primitives/Select'
import { VisualOnlyTooltip } from '@/primitives/VisualOnlyTooltip'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskGroup,
  ApiTaskList,
  PatchTaskPayload,
  TaskOrdering,
  TaskOrderingField,
  TaskPriority,
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
  taskLists?: ApiTaskList[]
  groups?: ApiTaskGroup[]
  grouped?: boolean
  ordering?: TaskOrdering
  onOrderingChange?: (ordering: TaskOrdering) => void
  selectedTaskId?: string
  onOpen: (task: ApiTask) => void
  onShare?: (task: ApiTask) => void
  onDeleteTask?: (task: ApiTask) => void
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
  onTaskContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    task: ApiTask
  ) => void
  editingCell: InlineEditingCell | null
  inlineDraft: string
  inlinePending: boolean
  onBeginInlineEdit: (task: ApiTask, field: InlineEditableField) => void
  onInlineDraftChange: (value: string) => void
  onSaveInlineEdit: (task: ApiTask, patch: PatchTaskPayload) => void
  onCancelInlineEdit: () => void
}

type StatusOverride = {
  status: TaskStatus
  pending: boolean
  baseUpdatedAt: string
}

type InlineEditableField =
  | 'title'
  | 'assignee'
  | 'priority'
  | 'startDate'
  | 'dueDate'
  | 'taskList'

type InlineEditingCell = {
  taskId: string
  field: InlineEditableField
}

type InlineTaskOverride = {
  task: ApiTask
  baseUpdatedAt: string
}

const priorities: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent']

export const TaskList = ({
  tasks,
  taskLists = [],
  groups = [],
  grouped = false,
  ordering = '',
  onOrderingChange,
  selectedTaskId,
  onOpen,
  onShare,
  onDeleteTask,
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
  const [editingCell, setEditingCell] = useState<InlineEditingCell | null>(null)
  const [inlineDraft, setInlineDraft] = useState('')
  const [inlinePending, setInlinePending] = useState(false)
  const [inlineOverrides, setInlineOverrides] = useState<
    Record<string, InlineTaskOverride>
  >({})
  const [assigneeEditingTask, setAssigneeEditingTask] =
    useState<ApiTask | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    task: ApiTask
    x: number
    y: number
  } | null>(null)
  const [columnWidths, setColumnWidths] =
    useState<TaskColumnWidths>(readColumnWidths)
  const columnWidthsRef = useRef(columnWidths)
  const [resizingColumn, setResizingColumn] = useState<TaskColumnId>()
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set()
  )
  const displayedTasks = useMemo(
    () => tasks.map((task) => inlineOverrides[task.id]?.task ?? task),
    [inlineOverrides, tasks]
  )
  const sections = useMemo(
    () => buildSections(displayedTasks, groups, grouped),
    [displayedTasks, grouped, groups]
  )

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])
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

  useEffect(() => {
    setInlineOverrides((current) => {
      let changed = false
      const next = { ...current }
      const visibleTaskIds = new Set(tasks.map((task) => task.id))
      for (const [taskId, override] of Object.entries(next)) {
        const task = tasks.find((candidate) => candidate.id === taskId)
        if (
          !visibleTaskIds.has(taskId) ||
          (task && task.updated_at !== override.baseUpdatedAt)
        ) {
          delete next[taskId]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [tasks])

  const beginInlineEdit = (task: ApiTask, field: InlineEditableField) => {
    if (!task.can_edit || inlinePending || patchMutation.isPending) return
    setStatusError(false)
    setEditingCell({ taskId: task.id, field })
    if (field === 'title') setInlineDraft(task.title)
    if (field === 'priority') setInlineDraft(task.priority)
    if (field === 'startDate') setInlineDraft(task.start_date || '')
    if (field === 'dueDate') setInlineDraft(task.due_date || '')
    if (field === 'taskList') setInlineDraft(task.task_list?.id || '')
    if (field === 'assignee') setAssigneeEditingTask(task)
  }

  const cancelInlineEdit = () => {
    if (inlinePending) return
    setEditingCell(null)
    setAssigneeEditingTask(null)
  }

  const saveInlineEdit = async (task: ApiTask, patch: PatchTaskPayload) => {
    const unchanged =
      (patch.title !== undefined && patch.title === task.title) ||
      (patch.priority !== undefined && patch.priority === task.priority) ||
      (patch.start_date !== undefined &&
        patch.start_date === task.start_date) ||
      (patch.due_date !== undefined && patch.due_date === task.due_date) ||
      (patch.task_list_id !== undefined &&
        (patch.task_list_id || null) === (task.task_list?.id || null) &&
        (patch.group_id === undefined ||
          (patch.group_id || null) === (task.group?.id || null))) ||
      (patch.assignee_id !== undefined &&
        patch.assignee_id === task.assignee?.id)
    if (unchanged) {
      setEditingCell(null)
      setAssigneeEditingTask(null)
      return
    }

    setInlinePending(true)
    setStatusError(false)
    try {
      const updatedTask = await patchMutation.mutateAsync({
        taskId: task.id,
        patch,
      })
      setInlineOverrides((current) => ({
        ...current,
        [task.id]: { task: updatedTask, baseUpdatedAt: task.updated_at },
      }))
      setEditingCell(null)
      setAssigneeEditingTask(null)
    } catch {
      setStatusError(true)
    } finally {
      setInlinePending(false)
    }
  }

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

  const showTaskContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    task: ApiTask
  ) => {
    if (!onShare && !onDeleteTask) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ task, x: event.clientX, y: event.clientY })
  }

  const groupProps = {
    grouped,
    taskLists,
    selectedTaskId,
    onOpen,
    registerRow,
    t,
    formatDate,
    formatDateTime,
    onToggleStatus: (task: ApiTask) => void toggleTaskStatus(task),
    onTaskContextMenu: showTaskContextMenu,
    editingCell,
    inlineDraft,
    inlinePending,
    onBeginInlineEdit: beginInlineEdit,
    onInlineDraftChange: setInlineDraft,
    onSaveInlineEdit: (task: ApiTask, patch: PatchTaskPayload) =>
      void saveInlineEdit(task, patch),
    onCancelInlineEdit: cancelInlineEdit,
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
      {assigneeEditingTask && (
        <ContactPicker
          includeSelf
          title={t('form.selectAssignee')}
          searchPlaceholder={t('form.searchAssignee')}
          onClose={cancelInlineEdit}
          onSelect={(member: DirectoryMember) => {
            setAssigneeEditingTask(null)
            void saveInlineEdit(assigneeEditingTask, {
              assignee_id: member.id,
            })
          }}
        />
      )}
      {contextMenu && (onShare || onDeleteTask) && (
        <div
          role="menu"
          tabIndex={-1}
          aria-label={t('actions.more')}
          className={taskContextMenuCss}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onShare && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onShare(contextMenu.task)
                setContextMenu(null)
              }}
            >
              <RiShareForwardLine size={16} aria-hidden="true" />
              <span>{t('share.action')}</span>
            </button>
          )}
          {onDeleteTask && (
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.task.can_delete}
              className={taskContextDeleteCss}
              onClick={() => {
                onDeleteTask(contextMenu.task)
                setContextMenu(null)
              }}
            >
              <RiDeleteBinLine size={16} aria-hidden="true" />
              <span>{t('actions.delete')}</span>
            </button>
          )}
        </div>
      )}
    </>
  )
}

const DesktopTaskGroup = (props: GroupProps) => <DesktopTaskRow {...props} />

const DesktopTaskRow = ({
  task,
  taskLists = [],
  grouped,
  isLastInGroup,
  selectedTaskId,
  onOpen,
  onTaskContextMenu,
  registerRow,
  t,
  formatDate,
  formatDateTime,
  statusOverride,
  statusPending,
  onToggleStatus,
  editingCell,
  inlineDraft,
  inlinePending,
  onBeginInlineEdit,
  onInlineDraftChange,
  onSaveInlineEdit,
  onCancelInlineEdit,
}: GroupProps) => (
  <tr
    ref={(element) => registerRow(task.id, element)}
    tabIndex={0}
    aria-label={t('workspace.openTask', { title: task.title })}
    data-selected={selectedTaskId === task.id || undefined}
    data-grouped={grouped || undefined}
    data-group-last={grouped && isLastInGroup ? true : undefined}
    className={rowCss}
    draggable={task.can_edit && editingCell?.taskId !== task.id}
    onDragStart={(event) => startTaskDrag(event, task)}
    onClick={() => onOpen(task)}
    onContextMenu={(event) => onTaskContextMenu(event, task)}
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
        {editingCell?.taskId === task.id && editingCell.field === 'title' ? (
          <InlineTitleEditor
            value={inlineDraft}
            pending={inlinePending}
            onChange={onInlineDraftChange}
            onSave={(title) => onSaveInlineEdit(task, { title })}
            onCancel={onCancelInlineEdit}
          />
        ) : (
          <InlineEditButton
            task={task}
            fieldLabel={t('workspace.columns.title')}
            pending={
              inlinePending &&
              editingCell?.taskId === task.id &&
              editingCell.field === 'title'
            }
            onEdit={() => onBeginInlineEdit(task, 'title')}
          >
            <TaskTitle task={task} status={statusOverride ?? task.status} />
          </InlineEditButton>
        )}
      </div>
    </td>
    <td>
      <InlineEditButton
        task={task}
        fieldLabel={t('workspace.columns.assignee')}
        select
        pending={
          inlinePending &&
          editingCell?.taskId === task.id &&
          editingCell.field === 'assignee'
        }
        onEdit={() => onBeginInlineEdit(task, 'assignee')}
      >
        <TaskUserDisplay user={task.assignee} />
      </InlineEditButton>
    </td>
    <td>
      {editingCell?.taskId === task.id && editingCell.field === 'priority' ? (
        <InlinePriorityEditor
          value={inlineDraft as TaskPriority}
          pending={inlinePending}
          label={t('workspace.columns.priority')}
          onChange={onInlineDraftChange}
          onSave={(priority) => onSaveInlineEdit(task, { priority })}
          onCancel={onCancelInlineEdit}
        />
      ) : (
        <InlineEditButton
          task={task}
          fieldLabel={t('workspace.columns.priority')}
          select
          pending={
            inlinePending &&
            editingCell?.taskId === task.id &&
            editingCell.field === 'priority'
          }
          onEdit={() => onBeginInlineEdit(task, 'priority')}
        >
          <TaskPriorityBadge priority={task.priority} />
        </InlineEditButton>
      )}
    </td>
    <td className={secondaryColumnCss}>
      {editingCell?.taskId === task.id && editingCell.field === 'startDate' ? (
        <InlineDateEditor
          value={inlineDraft}
          max={task.due_date || undefined}
          pending={inlinePending}
          label={t('workspace.columns.startDate')}
          onChange={onInlineDraftChange}
          onSave={(startDate) =>
            onSaveInlineEdit(task, { start_date: startDate || null })
          }
          onCancel={onCancelInlineEdit}
        />
      ) : (
        <InlineEditButton
          task={task}
          fieldLabel={t('workspace.columns.startDate')}
          date
          onEdit={() => onBeginInlineEdit(task, 'startDate')}
        >
          {formatDate(task.start_date)}
        </InlineEditButton>
      )}
    </td>
    <td
      data-overdue={task.time_state === 'overdue' || undefined}
      className={dueDateCss}
    >
      {editingCell?.taskId === task.id && editingCell.field === 'dueDate' ? (
        <InlineDateEditor
          value={inlineDraft}
          min={task.start_date || undefined}
          pending={inlinePending}
          label={t('workspace.columns.dueDate')}
          onChange={onInlineDraftChange}
          onSave={(dueDate) =>
            onSaveInlineEdit(task, { due_date: dueDate || null })
          }
          onCancel={onCancelInlineEdit}
        />
      ) : (
        <InlineEditButton
          task={task}
          fieldLabel={t('workspace.columns.dueDate')}
          date
          onEdit={() => onBeginInlineEdit(task, 'dueDate')}
        >
          {formatDate(task.due_date)}
        </InlineEditButton>
      )}
    </td>
    {!grouped && (
      <td className={secondaryColumnCss}>
        {editingCell?.taskId === task.id && editingCell.field === 'taskList' ? (
          <InlineTaskListEditor
            value={inlineDraft}
            pending={inlinePending}
            label={t('workspace.columns.taskList')}
            taskLists={taskLists}
            onChange={onInlineDraftChange}
            onSave={(taskListId) =>
              onSaveInlineEdit(task, {
                task_list_id: taskListId || null,
                group_id: null,
              })
            }
            onCancel={onCancelInlineEdit}
          />
        ) : (
          <InlineEditButton
            task={task}
            fieldLabel={t('workspace.columns.taskList')}
            select
            onEdit={() => onBeginInlineEdit(task, 'taskList')}
          >
            {task.task_list?.name || t('taskLists.standalone')}
          </InlineEditButton>
        )}
      </td>
    )}
    <td className={secondaryColumnCss}>
      <TaskUserDisplay user={task.creator} />
    </td>
    <td className={wideColumnCss}>{formatDateTime(task.created_at)}</td>
    <td aria-hidden="true" className={tableGutterCellCss} />
  </tr>
)

const InlineEditButton = ({
  task,
  fieldLabel,
  select = false,
  date = false,
  pending = false,
  onEdit,
  children,
}: {
  task: ApiTask
  fieldLabel: string
  select?: boolean
  date?: boolean
  pending?: boolean
  onEdit: () => void
  children: ReactNode
}) => {
  const { t } = useTranslation('tasks')
  if (!task.can_edit) {
    return <div className={inlineCellReadOnlyCss}>{children}</div>
  }
  return (
    <button
      type="button"
      className={inlineCellButtonCss}
      data-select={select || undefined}
      data-date={date || undefined}
      aria-label={`${t('actions.edit')} ${fieldLabel}`}
      aria-busy={pending || undefined}
      disabled={pending}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onEdit()
      }}
    >
      <span className={inlineCellValueCss}>{children}</span>
      {select && !pending && (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#7C7C7C"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-inline-select-chevron
          data-inline-control-icon
          className={inlineControlIconCss}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      )}
      {date && !pending && (
        <RiCalendarLine
          aria-hidden="true"
          size={16}
          data-inline-date-icon
          data-inline-control-icon
          className={inlineControlIconCss}
        />
      )}
      {pending && (
        <RiLoader4Line
          aria-hidden="true"
          size={14}
          className={inlineCellSpinnerCss}
        />
      )}
    </button>
  )
}

const InlineTitleEditor = ({
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  pending: boolean
  onChange: (value: string) => void
  onSave: (value: string) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const save = () => {
    const title = value.trim()
    if (title) onSave(title)
    else onCancel()
  }
  return (
    <input
      ref={inputRef}
      className={inlineCellInputCss}
      aria-label={`${t('actions.edit')} ${t('workspace.columns.title')}`}
      value={value}
      maxLength={500}
      disabled={pending}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={save}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

const InlinePriorityEditor = ({
  value,
  pending,
  label,
  onChange,
  onSave,
  onCancel,
}: {
  value: TaskPriority
  pending: boolean
  label: string
  onChange: (value: string) => void
  onSave: (value: TaskPriority) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <InlineSelectEditor
      label={`${t('actions.edit')} ${label}`}
      value={value}
      disabled={pending}
      items={priorities.map((priority) => ({
        value: priority,
        label: t(`priorities.${priority}`),
      }))}
      onChange={(priority) => {
        onChange(priority)
        onSave(priority as TaskPriority)
      }}
      onCancel={onCancel}
    />
  )
}

const InlineTaskListEditor = ({
  value,
  pending,
  label,
  taskLists,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  pending: boolean
  label: string
  taskLists: ApiTaskList[]
  onChange: (value: string) => void
  onSave: (value: string) => void
  onCancel: () => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <InlineSelectEditor
      label={`${t('actions.edit')} ${label}`}
      value={value}
      disabled={pending}
      items={[
        { value: '', label: t('taskLists.standalone') },
        ...taskLists.map((taskList) => ({
          value: taskList.id,
          label: taskList.name,
        })),
      ]}
      onChange={(taskListId) => {
        onChange(taskListId)
        onSave(taskListId)
      }}
      onCancel={onCancel}
    />
  )
}

const InlineSelectEditor = ({
  label,
  value,
  disabled,
  items,
  onChange,
  onCancel,
}: {
  label: string
  value: string
  disabled: boolean
  items: Array<{ value: string; label: ReactNode }>
  onChange: (value: string) => void
  onCancel: () => void
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectionCommitted = useRef(false)
  const [isOpen, setIsOpen] = useState(true)

  useEffect(() => triggerRef.current?.focus(), [])

  return (
    <Select
      aria-label={label}
      className={inlineSelectCss}
      triggerRef={triggerRef}
      items={items}
      selectedKey={value}
      isDisabled={disabled}
      isOpen={isOpen}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onOpenChange={(open) => {
        setIsOpen(open)
        if (!open) {
          window.setTimeout(() => {
            if (!selectionCommitted.current) onCancel()
          })
        }
      }}
      onSelectionChange={(key) => {
        selectionCommitted.current = true
        onChange(String(key))
      }}
    />
  )
}

const InlineDateEditor = ({
  value,
  min,
  max,
  pending,
  label,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  min?: string
  max?: string
  pending: boolean
  label: string
  onChange: (value: string) => void
  onSave: (value: string) => void
  onCancel: () => void
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  return (
    <span className={inlineDateEditorCss}>
      <input
        ref={inputRef}
        type="date"
        className={inlineCellInputCss}
        aria-label={label}
        value={value}
        min={min}
        max={max}
        disabled={pending}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onSave(value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <RiCalendarLine
        aria-hidden="true"
        size={16}
        data-inline-date-icon
        className={inlineDateEditorIconCss}
      />
    </span>
  )
}

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
  onTaskContextMenu,
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
    onContextMenu={(event) => onTaskContextMenu(event, task)}
    onKeyDown={(event) => openOnEnter(event, task, onOpen)}
  >
    <div className={mobileTitleRowCss}>
      <TaskStatusButton
        task={task}
        status={statusOverride ?? task.status}
        pending={statusPending}
        onToggle={onToggleStatus}
      />
      <TaskTitle task={task} status={statusOverride ?? task.status} />
      <TaskPriorityBadge priority={task.priority} />
    </div>
    <dl className={mobileMetaCss}>
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

const TaskTitle = ({ task, status }: { task: ApiTask; status: TaskStatus }) => {
  const { t } = useTranslation('tasks')
  return (
    <span
      className={titleCellCss}
      data-completed={status === 'completed' || undefined}
    >
      <span className={titleLineCss}>
        <strong>{task.title}</strong>
      </span>
      {task.source_room_name && (
        <span className={titleMetaCss}>
          {t('sourceMeeting', { name: task.source_room_name })}
        </span>
      )}
    </span>
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
const inlineCellButtonCss = css({
  width: '100%',
  minWidth: 0,
  minHeight: '1.75rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  margin: '-0.25rem',
  padding: '0.25rem',
  border: '1px solid transparent',
  borderRadius: '4px',
  backgroundColor: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'text',
  outline: 'none',
  _hover: {
    borderColor: 'greyscale.300',
    backgroundColor: 'greyscale.000',
  },
  _focusVisible: {
    borderColor: 'primary.500',
    boxShadow: '0 0 0 1px token(colors.primary.200)',
  },
  '&[data-select], &[data-date]': {
    borderRadius: '8px',
    cursor: 'pointer',
  },
  '&[data-select]:hover [data-inline-control-icon], &[data-select]:focus-visible [data-inline-control-icon], &[data-date]:hover [data-inline-control-icon], &[data-date]:focus-visible [data-inline-control-icon]':
    { opacity: 1 },
  _disabled: { cursor: 'wait' },
})
const inlineCellReadOnlyCss = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})
const inlineCellValueCss = css({
  minWidth: 0,
  flex: 1,
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})
const inlineCellInputCss = css({
  width: '100%',
  minWidth: 0,
  height: '1.75rem',
  paddingX: '0.375rem',
  border: '1px solid token(colors.primary.500)',
  borderRadius: '4px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  font: 'inherit',
  outline: 'none',
  boxShadow: '0 0 0 1px token(colors.primary.200)',
  '&[type="date"]': { paddingRight: '1.75rem' },
  '&[type="date"]::-webkit-calendar-picker-indicator': {
    opacity: 0,
    cursor: 'pointer',
  },
  '&:disabled': { cursor: 'wait', opacity: 0.7 },
})
const inlineSelectCss = css({ width: '100%', minWidth: 0 })
const inlineControlIconCss = css({
  flexShrink: 0,
  color: 'greyscale.600',
  opacity: 0,
  transition: 'opacity token(durations.fast)',
})
const inlineDateEditorCss = css({
  position: 'relative',
  width: '100%',
  minWidth: 0,
  display: 'block',
})
const inlineDateEditorIconCss = css({
  position: 'absolute',
  top: '50%',
  right: '0.375rem',
  color: 'greyscale.600',
  pointerEvents: 'none',
  transform: 'translateY(-50%)',
})
const inlineCellSpinnerCss = css({
  flexShrink: 0,
  color: 'primary.500',
  animation: 'rotate 700ms linear infinite',
})
const taskContextMenuCss = css({
  position: 'fixed',
  zIndex: 'popover',
  minWidth: '10rem',
  padding: '0.25rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  boxShadow: 'lg',
  fontSize: '0.875rem',
  '& button': {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.125rem 0.5rem',
    border: 0,
    borderRadius: '0.375rem',
    backgroundColor: 'transparent',
    color: 'greyscale.900',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.100' },
    _disabled: {
      color: 'greyscale.400',
      cursor: 'not-allowed',
      backgroundColor: 'transparent',
    },
  },
})
const taskContextDeleteCss = css({
  color: 'danger.600!',
  _disabled: { color: 'greyscale.400!' },
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
  '&[data-completed] strong': { color: 'default.subtle-text' },
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
