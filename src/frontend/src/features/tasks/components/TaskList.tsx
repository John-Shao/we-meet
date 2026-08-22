import {
  Fragment,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react'

import { Button, Menu, MenuList } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTask, ApiTaskGroup } from '../api/ApiTask'
import { usePatchTask, useTaskSubtasks } from '../api/fetchTasks'
import { quickTaskStatus, taskDisplayName } from '../taskUi'
import { TaskLabelBadge } from './TaskLabelBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'

type ListProps = {
  tasks: ApiTask[]
  groups?: ApiTaskGroup[]
  grouped?: boolean
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
  t: TFunction<'tasks'>
  formatDate: (value: string | null) => string
  formatDateTime: (value: string) => string
  quickStatusPending: boolean
  onQuickStatus: (task: ApiTask) => void
}

export const TaskList = ({
  tasks,
  groups = [],
  grouped = false,
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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set()
  )
  const sections = useMemo(
    () => buildSections(tasks, groups, grouped),
    [grouped, groups, tasks]
  )

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

  const updateQuickStatus = (task: ApiTask) => {
    const status = quickTaskStatus(task)
    if (!status) return
    patchMutation.mutate({ taskId: task.id, patch: { status } })
  }

  const moveToGroup = (taskId: string, groupId?: string) => {
    patchMutation.mutate({
      taskId,
      patch: { group_id: groupId || null },
    })
  }

  const groupProps = {
    selectedTaskId,
    onOpen,
    registerRow,
    t,
    formatDate,
    formatDateTime,
    quickStatusPending: patchMutation.isPending,
    onQuickStatus: updateQuickStatus,
  }

  return (
    <>
      <table className={tableCss}>
        <thead>
          <tr>
            <th className={statusColumnCss}>{t('workspace.columns.status')}</th>
            <th>{t('workspace.columns.title')}</th>
            <th>{t('workspace.columns.assignee')}</th>
            <th>{t('workspace.columns.priority')}</th>
            <th className={secondaryColumnCss}>
              {t('workspace.columns.startDate')}
            </th>
            <th>{t('workspace.columns.dueDate')}</th>
            <th>{t('workspace.columns.labels')}</th>
            <th className={secondaryColumnCss}>
              {t('workspace.columns.creator')}
            </th>
            <th className={wideColumnCss}>
              {t('workspace.columns.updatedAt')}
            </th>
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
                  />
                )}
                {!collapsed &&
                  section.tasks.map((task) => (
                    <DesktopTaskGroup
                      key={task.id}
                      task={task}
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
                <ul className={mobileSectionTasksCss}>
                  {section.tasks.map((task) => (
                    <MobileTaskGroup
                      key={task.id}
                      task={task}
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

const DesktopTaskGroup = (props: GroupProps) => {
  const { task, t } = props
  const [expanded, setExpanded] = useState(task.subtask_count > 0)
  const subtasks = useTaskSubtasks(task.id, expanded && task.subtask_count > 0)
  return (
    <>
      <DesktopTaskRow
        {...props}
        expandable={task.subtask_count > 0}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && subtasks.isLoading && (
        <tr className={subtaskStateRowCss}>
          <td colSpan={9}>{t('subtasks.loading')}</td>
        </tr>
      )}
      {expanded && subtasks.error && (
        <tr className={subtaskStateRowCss}>
          <td colSpan={9}>{t('subtasks.error')}</td>
        </tr>
      )}
      {expanded &&
        subtasks.data?.map((subtask) => (
          <DesktopTaskRow
            key={subtask.id}
            {...props}
            task={subtask}
            isSubtask
          />
        ))}
    </>
  )
}

const DesktopTaskRow = ({
  task,
  selectedTaskId,
  onOpen,
  registerRow,
  t,
  formatDate,
  formatDateTime,
  quickStatusPending,
  onQuickStatus,
  isSubtask = false,
  expandable = false,
  expanded = false,
  onToggle,
}: GroupProps & {
  isSubtask?: boolean
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
}) => (
  <tr
    ref={(element) => registerRow(task.id, element)}
    tabIndex={0}
    aria-label={t('workspace.openTask', { title: task.title })}
    data-selected={selectedTaskId === task.id || undefined}
    data-subtask={isSubtask || undefined}
    className={rowCss}
    draggable={!isSubtask && task.can_edit}
    onDragStart={(event) => startTaskDrag(event, task)}
    onClick={() => onOpen(task)}
    onKeyDown={(event) => openOnEnter(event, task, onOpen)}
  >
    <td className={statusColumnCss}>
      <StatusButton
        task={task}
        pending={quickStatusPending}
        onQuickStatus={onQuickStatus}
        t={t}
      />
    </td>
    <td>
      <TaskTitle
        task={task}
        isSubtask={isSubtask}
        expandable={expandable}
        expanded={expanded}
        onToggle={onToggle}
      />
    </td>
    <td>{taskDisplayName(task.assignee)}</td>
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
    <td>
      <TaskLabels task={task} />
    </td>
    <td className={secondaryColumnCss}>{taskDisplayName(task.creator)}</td>
    <td className={wideColumnCss}>{formatDateTime(task.updated_at)}</td>
  </tr>
)

const MobileTaskGroup = (props: GroupProps) => {
  const { task, t } = props
  const [expanded, setExpanded] = useState(task.subtask_count > 0)
  const subtasks = useTaskSubtasks(task.id, expanded && task.subtask_count > 0)
  return (
    <li>
      <MobileTaskCard
        {...props}
        expandable={task.subtask_count > 0}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && subtasks.isLoading && (
        <p className={mobileSubtaskStateCss}>{t('subtasks.loading')}</p>
      )}
      {expanded && subtasks.error && (
        <p className={mobileSubtaskStateCss}>{t('subtasks.error')}</p>
      )}
      {expanded && subtasks.data && subtasks.data.length > 0 && (
        <ul className={mobileSubtaskListCss}>
          {subtasks.data.map((subtask) => (
            <li key={subtask.id}>
              <MobileTaskCard {...props} task={subtask} isSubtask />
            </li>
          ))}
        </ul>
      )}
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
  quickStatusPending,
  onQuickStatus,
  isSubtask = false,
  expandable = false,
  expanded = false,
  onToggle,
}: GroupProps & {
  isSubtask?: boolean
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
}) => (
  <div
    ref={(element) => registerRow(task.id, element)}
    tabIndex={0}
    role="button"
    aria-label={t('workspace.openTask', { title: task.title })}
    data-selected={selectedTaskId === task.id || undefined}
    data-subtask={isSubtask || undefined}
    className={mobileCardCss}
    draggable={!isSubtask && task.can_edit}
    onDragStart={(event) => startTaskDrag(event, task)}
    onClick={() => onOpen(task)}
    onKeyDown={(event) => openOnEnter(event, task, onOpen)}
  >
    <div className={mobileTitleRowCss}>
      <StatusButton
        task={task}
        pending={quickStatusPending}
        onQuickStatus={onQuickStatus}
        t={t}
      />
      <TaskTitle
        task={task}
        isSubtask={isSubtask}
        expandable={expandable}
        expanded={expanded}
        onToggle={onToggle}
      />
      <TaskPriorityBadge priority={task.priority} />
    </div>
    <dl className={mobileMetaCss}>
      <div>
        <dt>{t('workspace.columns.assignee')}</dt>
        <dd>{taskDisplayName(task.assignee)}</dd>
      </div>
      <div>
        <dt>{t('workspace.columns.dueDate')}</dt>
        <dd data-overdue={task.time_state === 'overdue' || undefined}>
          {formatDate(task.due_date)}
        </dd>
      </div>
    </dl>
    <TaskLabels task={task} />
  </div>
)

const StatusButton = ({
  task,
  pending,
  onQuickStatus,
  t,
}: {
  task: ApiTask
  pending: boolean
  onQuickStatus: (task: ApiTask) => void
  t: TFunction<'tasks'>
}) => {
  const quickStatus = quickTaskStatus(task)
  return (
    <button
      type="button"
      className={statusButtonCss}
      data-complete={task.status === 'completed' || undefined}
      disabled={!quickStatus || pending}
      aria-label={
        quickStatus === 'completed'
          ? t('workspace.quickComplete', { title: task.title })
          : t('workspace.quickReopen', { title: task.title })
      }
      onClick={(event) => {
        event.stopPropagation()
        onQuickStatus(task)
      }}
    >
      {task.status === 'completed' ? '\u2713' : ''}
    </button>
  )
}

const TaskTitle = ({
  task,
  isSubtask,
  expandable,
  expanded,
  onToggle,
}: {
  task: ApiTask
  isSubtask: boolean
  expandable: boolean
  expanded: boolean
  onToggle?: () => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={titleCellCss} data-subtask={isSubtask || undefined}>
      <div className={titleLineCss}>
        {expandable ? (
          <button
            type="button"
            className={expandButtonCss}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t('subtasks.hide')
                : t('subtasks.show', {
                    completed: task.completed_subtask_count,
                    total: task.subtask_count,
                  })
            }
            onClick={(event) => {
              event.stopPropagation()
              onToggle?.()
            }}
          >
            {expanded ? (
              <RiArrowDownSLine size={16} />
            ) : (
              <RiArrowRightSLine size={16} />
            )}
          </button>
        ) : isSubtask ? (
          <span className={subtaskConnectorCss} aria-hidden="true" />
        ) : null}
        <strong>{task.title}</strong>
      </div>
      <span className={titleMetaCss}>
        {t(`statuses.${task.status}`)}
        {task.subtask_count > 0 &&
          ` · ${t('subtasks.show', {
            completed: task.completed_subtask_count,
            total: task.subtask_count,
          })}`}
        {task.source_room_name &&
          ` · ${t('sourceMeeting', { name: task.source_room_name })}`}
      </span>
    </div>
  )
}

const TaskLabels = ({ task }: { task: ApiTask }) => (
  <div className={labelsCss}>
    {task.labels.slice(0, 2).map((label) => (
      <TaskLabelBadge key={label.id} label={label} />
    ))}
    {task.labels.length > 2 && (
      <span className={moreCss}>+{task.labels.length - 2}</span>
    )}
  </div>
)

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
    <tr
      className={groupHeaderRowCss}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => dropTask(event, section.group?.id, onMoveTask)}
    >
      <td colSpan={9}>
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
          <span>{section.tasks.length}</span>
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
      onDragOver={(event) => event.preventDefault()}
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
      <span>{section.tasks.length}</span>
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
        className={groupMoreButtonCss}
        size="dense"
        variant="secondaryText"
      >
        {t('groups.more')}
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

const dropTask = (
  event: DragEvent<HTMLElement>,
  groupId: string | undefined,
  onMoveTask: (taskId: string, groupId?: string) => void
) => {
  event.preventDefault()
  const taskId = event.dataTransfer.getData('application/x-we-meet-task')
  if (taskId) onMoveTask(taskId, groupId)
}

const tableCss = css({
  display: { base: 'none', md: 'table' },
  width: '100%',
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
  '& td': {
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid token(colors.greyscale.200)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
  },
  '& th:nth-child(2)': { width: '30%' },
})
const rowCss = css({
  cursor: 'pointer',
  outline: 'none',
  _hover: { backgroundColor: 'greyscale.50' },
  _focusVisible: { boxShadow: 'inset 0 0 0 2px token(colors.primary.500)' },
  '&[data-selected]': { backgroundColor: 'selected.bg' },
  '&[data-subtask]': { backgroundColor: 'greyscale.50' },
  '&[data-subtask][data-selected]': { backgroundColor: 'selected.bg' },
})
const groupHeaderRowCss = css({
  '& td': {
    padding: '0.875rem 0.75rem 0.375rem!',
    borderBottom: '0!important',
    overflow: 'visible!important',
  },
})
const groupHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2rem',
  color: 'greyscale.700',
  '& strong': { fontSize: '0.875rem' },
  '& > span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const groupCreateTaskCss = css({
  marginLeft: 'auto',
  padding: '0.25rem 0.5rem',
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'primary.700',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
const groupMoreMenuCss = css({
  '& [role="menuitem"]': {
    paddingY: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
})
const groupMoreButtonCss = css({
  marginLeft: '0!',
  padding: '0.25rem 0.5rem!',
  border: '0!',
  borderRadius: '6px!',
  backgroundColor: 'transparent!',
  color: 'primary.700!',
  fontSize: '0.75rem!',
  lineHeight: 'normal!',
  _hover: { backgroundColor: 'greyscale.100!' },
})
const subtaskStateRowCss = css({
  color: 'default.subtle-text',
  '& td': { paddingLeft: '4.75rem!', fontSize: '0.75rem!' },
})
const statusColumnCss = css({ width: '3rem' })
const secondaryColumnCss = css({ display: { md: 'none', lg: 'table-cell' } })
const wideColumnCss = css({ display: { md: 'none', xl: 'table-cell' } })
const statusButtonCss = css({
  width: '1.25rem',
  height: '1.25rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.000',
  cursor: 'pointer',
  '&[data-complete]': {
    borderColor: 'success.500',
    backgroundColor: 'success.500',
  },
  _disabled: { cursor: 'default', opacity: 0.6 },
})
const titleCellCss = css({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  overflow: 'hidden',
  '&[data-subtask]': { paddingLeft: '1rem' },
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
const subtaskConnectorCss = css({
  width: '1rem',
  height: '0.75rem',
  flexShrink: 0,
  borderLeft: '1px solid token(colors.greyscale.300)',
  borderBottom: '1px solid token(colors.greyscale.300)',
  borderBottomLeftRadius: '6px',
})
const titleMetaCss = css({
  overflow: 'hidden',
  color: 'default.subtle-text',
  fontSize: '0.6875rem',
  textOverflow: 'ellipsis',
})
const labelsCss = css({ display: 'flex', gap: '0.25rem', overflow: 'hidden' })
const moreCss = css({ color: 'default.subtle-text', fontSize: '0.75rem' })
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
})
const mobileGroupHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2.5rem',
  '& strong': { fontSize: '0.875rem' },
  '& > span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const mobileSubtaskListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  listStyle: 'none',
  margin: '0.5rem 0 0 1rem',
  padding: 0,
})
const mobileSubtaskStateCss = css({
  margin: '0.5rem 0 0 1rem',
  color: 'default.subtle-text',
  fontSize: '0.75rem',
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
  '&[data-subtask]': { backgroundColor: 'greyscale.50' },
  '&[data-selected]': {
    borderColor: 'selected.accent',
    backgroundColor: 'selected.bg',
  },
  _focusVisible: { boxShadow: '0 0 0 2px token(colors.primary.400)' },
})
const mobileTitleRowCss = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'start',
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
