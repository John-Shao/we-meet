import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArchiveLine,
  RiFileAddLine,
  RiFolderAddLine,
  RiHistoryLine,
  RiListCheck3,
  RiListCheck,
  RiBookmarkLine,
  RiSettings3Line,
  RiUserLine,
} from '@remixicon/react'

import { Button, Menu, MenuList } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  ApiTaskGroup,
  ApiTaskList,
  ApiTaskListGroup,
} from '../api/ApiTask'
import type {
  TaskWorkspaceState,
  TaskWorkspaceView,
} from '../taskWorkspaceState'
import {
  taskNavigationActionButtonCss,
  taskNavigationActionsCss,
  taskNavigationMenuCss,
  taskNavigationMenuItemLabelCss,
} from './TaskWorkspaceNavigationStyles'
import {
  StandaloneTaskListNavigationRow,
  TaskListGroupNavigationNode,
  TaskListNavigationRow,
} from './TaskWorkspaceNavigationNodes'

const views: TaskWorkspaceView[] = ['all', 'assigned', 'following', 'created']
const collapsedListGroupsStorageKey = 'we-meet:task-list-groups-collapsed'

const initialCollapsedGroups = () => {
  if (typeof window === 'undefined') return new Set<string>()
  try {
    const value = JSON.parse(
      window.localStorage.getItem(collapsedListGroupsStorageKey) || '[]'
    )
    return new Set<string>(Array.isArray(value) ? value : [])
  } catch {
    return new Set<string>()
  }
}

const activeView = (state: TaskWorkspaceState): TaskWorkspaceView => {
  return state.scope
}

export const TaskWorkspaceNavigation = ({
  state,
  navigationCounts,
  taskLists,
  taskListGroups,
  taskGroups = [],
  standaloneTaskCount,
  onChange,
  onTaskListChange,
  onCreateTaskList,
  onCreateTaskListGroup,
  onSelectTaskGroup,
  onCreateTaskGroup,
  onManageTaskGroups,
  onMoveTaskList,
  onRenameTaskListGroup,
  onDeleteTaskListGroup,
  onShareTaskList,
  onRenameTaskList,
  onArchiveTaskList,
  onLeaveTaskList,
  onDeleteTaskList,
  onOpenArchivedTaskLists,
  onOpenActivity,
}: {
  state: TaskWorkspaceState
  navigationCounts: Record<TaskWorkspaceView, number>
  taskLists: ApiTaskList[]
  taskListGroups: ApiTaskListGroup[]
  taskGroups?: ApiTaskGroup[]
  standaloneTaskCount: number
  onChange: (view: TaskWorkspaceView) => void
  onTaskListChange: (taskListId: string) => void
  onCreateTaskList: (listGroupId?: string) => void
  onCreateTaskListGroup: () => void
  onSelectTaskGroup?: (group: ApiTaskGroup) => void
  onCreateTaskGroup?: () => void
  onManageTaskGroups?: () => void
  onMoveTaskList: (taskListId: string, listGroupId: string | null) => void
  onRenameTaskListGroup: (group: ApiTaskListGroup) => void
  onDeleteTaskListGroup: (group: ApiTaskListGroup) => void
  onShareTaskList?: (taskList: ApiTaskList) => void
  onRenameTaskList?: (taskList: ApiTaskList) => void
  onArchiveTaskList?: (taskList: ApiTaskList) => void
  onLeaveTaskList?: (taskList: ApiTaskList) => void
  onDeleteTaskList?: (taskList: ApiTaskList) => void
  onOpenArchivedTaskLists?: () => void
  onOpenActivity?: () => void
}) => {
  const { t } = useTranslation('tasks')
  const current = activeView(state)
  const orderedTaskGroups = [...taskGroups].sort(
    (first, second) =>
      first.sort_order - second.sort_order ||
      first.created_at.localeCompare(second.created_at)
  )
  const orderedTaskListGroups = [...taskListGroups].sort(
    (first, second) =>
      first.sort_order - second.sort_order ||
      first.created_at.localeCompare(second.created_at)
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    initialCollapsedGroups
  )
  const [draggedTaskListId, setDraggedTaskListId] = useState<string>()
  const taskListsByGroup = new Map(
    taskListGroups.map((group) => [group.id, [] as ApiTaskList[]])
  )
  const ungroupedLists: ApiTaskList[] = []
  taskLists.forEach((taskList) => {
    const groupedLists = taskList.list_group
      ? taskListsByGroup.get(taskList.list_group.id)
      : undefined
    if (groupedLists) groupedLists.push(taskList)
    else ungroupedLists.push(taskList)
  })
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups)
      if (nextGroups.has(groupId)) nextGroups.delete(groupId)
      else nextGroups.add(groupId)
      try {
        window.localStorage.setItem(
          collapsedListGroupsStorageKey,
          JSON.stringify([...nextGroups])
        )
      } catch {
        // Keep the current session responsive when storage is unavailable.
      }
      return nextGroups
    })
  }
  const startListDrag = (
    event: DragEvent<HTMLButtonElement>,
    taskList: ApiTaskList
  ) => {
    if (!taskList.can_manage) {
      event.preventDefault()
      return
    }
    setDraggedTaskListId(taskList.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-we-meet-task-list', taskList.id)
  }
  const allowListDrop = (event: DragEvent<HTMLElement>) => {
    if (!draggedTaskListId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }
  const dropList = (
    event: DragEvent<HTMLElement>,
    listGroupId: string | null
  ) => {
    event.preventDefault()
    const taskListId =
      event.dataTransfer.getData('application/x-we-meet-task-list') ||
      draggedTaskListId
    setDraggedTaskListId(undefined)
    if (!taskListId) return
    const taskList = taskLists.find((item) => item.id === taskListId)
    if (
      !taskList?.can_manage ||
      (taskList.list_group?.id || null) === listGroupId
    )
      return
    onMoveTaskList(taskListId, listGroupId)
  }
  const renderTaskList = (taskList: ApiTaskList) => (
    <TaskListNavigationRow
      key={taskList.id}
      taskList={taskList}
      active={state.group === 'all' && state.taskList === taskList.id}
      onSelect={() => onTaskListChange(taskList.id)}
      onDragStart={(event) => startListDrag(event, taskList)}
      onDragEnd={() => setDraggedTaskListId(undefined)}
      onShare={onShareTaskList ? () => onShareTaskList(taskList) : undefined}
      onRename={onRenameTaskList ? () => onRenameTaskList(taskList) : undefined}
      onArchive={
        onArchiveTaskList ? () => onArchiveTaskList(taskList) : undefined
      }
      onLeave={onLeaveTaskList ? () => onLeaveTaskList(taskList) : undefined}
      onDelete={onDeleteTaskList ? () => onDeleteTaskList(taskList) : undefined}
    />
  )
  return (
    <aside className={desktopNavCss} aria-label={t('workspace.navigation')}>
      <h1 className={navTitleCss}>{t('title')}</h1>
      <nav className={navListCss}>
        <p className={sectionLabelCss}>{t('workspace.taskViews')}</p>
        {views.map((view) => (
          <button
            key={view}
            type="button"
            aria-current={
              state.group === 'all' &&
              state.taskList === 'all' &&
              current === view
                ? 'page'
                : undefined
            }
            className={navButtonCss}
            data-active={
              state.group === 'all' &&
              state.taskList === 'all' &&
              current === view
                ? true
                : undefined
            }
            onClick={() => onChange(view)}
          >
            <span className={navLabelCss}>
              {view === 'assigned' ? (
                <RiUserLine size={18} />
              ) : view === 'following' ? (
                <RiBookmarkLine size={18} />
              ) : view === 'created' ? (
                <RiFileAddLine size={18} />
              ) : (
                <RiListCheck3 size={18} />
              )}
              <span>{t(`workspace.views.${view}`)}</span>
            </span>
            <span
              aria-label={t('workspace.openTaskCount', {
                count: navigationCounts[view],
              })}
            >
              {navigationCounts[view]}
            </span>
          </button>
        ))}
        <button type="button" className={navButtonCss} onClick={onOpenActivity}>
          <span className={navLabelCss}>
            <RiHistoryLine size={18} />
            <span>{t('activity.navigation')}</span>
          </span>
        </button>
        <div className={sectionHeaderCss}>
          <span>{t('groups.navigationTitle')}</span>
          <div
            className={taskNavigationActionsCss({ visibility: 'persistent' })}
          >
            <Button
              variant="tertiary"
              size="icon24"
              className={taskNavigationActionButtonCss}
              aria-label={t('groups.manage')}
              onPress={onManageTaskGroups}
            >
              <RiSettings3Line size={16} />
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              className={taskNavigationActionButtonCss}
              aria-label={t('groups.create')}
              onPress={onCreateTaskGroup}
            >
              <RiAddLine size={17} />
            </Button>
          </div>
        </div>
        {orderedTaskGroups.length === 0 ? (
          <p className={emptyListsCss}>{t('groups.emptyNavigation')}</p>
        ) : (
          orderedTaskGroups.map((group) => {
            const active = state.group === group.id
            return (
              <button
                key={group.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                className={navButtonCss}
                data-active={active || undefined}
                onClick={() => onSelectTaskGroup?.(group)}
              >
                <span className={navLabelCss}>
                  <RiListCheck size={18} />
                  <span>{group.name}</span>
                </span>
                <span
                  aria-label={t('groups.taskCount', {
                    count: group.task_count,
                  })}
                >
                  {group.task_count}
                </span>
              </button>
            )
          })
        )}
        <div
          className={sectionHeaderCss}
          data-list-drop-target={draggedTaskListId ? true : undefined}
          onDragOver={allowListDrop}
          onDrop={(event) => dropList(event, null)}
          title={
            draggedTaskListId ? t('taskListGroups.moveToUngrouped') : undefined
          }
        >
          <span>{t('taskLists.title')}</span>
          <div
            className={taskNavigationActionsCss({
              visibility: 'persistent',
            })}
            data-node-actions
          >
            <Menu placement="bottom">
              <Button
                variant="tertiary"
                size="icon24"
                className={taskNavigationActionButtonCss}
                aria-label={t('taskLists.title')}
              >
                <RiAddLine size={17} />
              </Button>
              <MenuList
                aria-label={t('taskLists.title')}
                menuClassName={taskNavigationMenuCss}
                items={[
                  {
                    value: 'list',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiListCheck size={16} />
                        {t('taskLists.create')}
                      </span>
                    ),
                  },
                  {
                    value: 'group',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiFolderAddLine size={16} />
                        {t('taskListGroups.create')}
                      </span>
                    ),
                  },
                ]}
                onAction={(action) => {
                  if (action === 'list') onCreateTaskList()
                  if (action === 'group') onCreateTaskListGroup()
                }}
              />
            </Menu>
          </div>
        </div>
        {taskLists.length === 0 &&
        taskListGroups.length === 0 &&
        standaloneTaskCount === 0 ? (
          <p className={emptyListsCss}>{t('taskLists.empty')}</p>
        ) : (
          <>
            {ungroupedLists.map(renderTaskList)}
            {orderedTaskListGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.id)
              const lists = taskListsByGroup.get(group.id) || []
              return (
                <TaskListGroupNavigationNode
                  key={group.id}
                  group={group}
                  collapsed={collapsed}
                  isEmpty={lists.length === 0}
                  onToggle={() => toggleGroup(group.id)}
                  onDragOver={allowListDrop}
                  onDrop={(event) => dropList(event, group.id)}
                  onCreateTaskList={() => onCreateTaskList(group.id)}
                  onRename={() => onRenameTaskListGroup(group)}
                  onDelete={() => onDeleteTaskListGroup(group)}
                >
                  {lists.map(renderTaskList)}
                </TaskListGroupNavigationNode>
              )
            })}
            {standaloneTaskCount > 0 && (
              <StandaloneTaskListNavigationRow
                active={
                  state.group === 'all' && state.taskList === 'unassigned'
                }
                onSelect={() => onTaskListChange('unassigned')}
              />
            )}
          </>
        )}
        <button
          type="button"
          className={navButtonCss}
          onClick={onOpenArchivedTaskLists}
        >
          <span className={navLabelCss}>
            <RiArchiveLine size={18} />
            <span>{t('taskLists.archivedTitle')}</span>
          </span>
        </button>
      </nav>
    </aside>
  )
}

const desktopNavCss = css({
  display: 'flex',
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '1rem 0.75rem',
  borderRight: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  overflowY: 'auto',
})
const navTitleCss = css({
  margin: '0 0 0.5rem',
  paddingX: '0.5rem',
  color: 'greyscale.900',
  fontSize: '1.125rem',
  fontWeight: 'bold',
})
const navListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})
const sectionLabelCss = css({
  margin: '0.75rem 0.5rem 0.25rem',
  color: 'greyscale.500',
  fontSize: '0.75rem',
  fontWeight: '500',
})
const sectionHeaderCss = css({
  minHeight: '2.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: '0.75rem',
  paddingLeft: '0.5rem',
  borderTop: '1px solid token(colors.greyscale.200)',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  fontWeight: '600',
  '&[data-list-drop-target]': {
    outline: '1px dashed token(colors.primary.400)',
    outlineOffset: '-2px',
    backgroundColor: 'selected.bg',
  },
})
const emptyListsCss = css({
  margin: '0.25rem 0.5rem',
  color: 'greyscale.500',
  fontSize: '0.75rem',
})
const navButtonCss = css({
  width: '100%',
  minHeight: '2.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  border: 0,
  borderRadius: '8px',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  backgroundColor: 'transparent',
  color: 'greyscale.700',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: '0.875rem',
  '&[data-active]': {
    backgroundColor: 'selected.bg',
    color: 'selected.text',
    fontWeight: '500',
  },
  _hover: { backgroundColor: 'greyscale.100' },
  '&[data-active]:hover': { backgroundColor: 'selected.bg' },
})
const navLabelCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  '& span': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})
