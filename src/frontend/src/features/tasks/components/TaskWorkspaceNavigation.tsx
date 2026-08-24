import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiCheckboxCircleLine,
  RiFileAddLine,
  RiFolderAddLine,
  RiHistoryLine,
  RiListCheck3,
  RiListCheck,
  RiUserLine,
} from '@remixicon/react'

import { Button, Menu, MenuList } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { ApiTaskList, ApiTaskListGroup } from '../api/ApiTask'
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
  TaskListGroupNavigationNode,
  TaskListNavigationRow,
} from './TaskWorkspaceNavigationNodes'

const views: TaskWorkspaceView[] = ['assigned', 'created', 'all', 'completed']

const activeView = (state: TaskWorkspaceState): TaskWorkspaceView => {
  if (state.scope === 'all' && state.status === 'completed') return 'completed'
  return state.scope
}

export const TaskWorkspaceNavigation = ({
  state,
  count,
  taskLists,
  taskListGroups,
  onChange,
  onTaskListChange,
  onCreateTaskList,
  onCreateTaskListGroup,
  onMoveTaskList,
  onRenameTaskListGroup,
  onDeleteTaskListGroup,
  onShareTaskList,
  onRenameTaskList,
  onArchiveTaskList,
  onLeaveTaskList,
  onDeleteTaskList,
  onOpenArchivedTaskLists,
}: {
  state: TaskWorkspaceState
  count: number
  taskLists: ApiTaskList[]
  taskListGroups: ApiTaskListGroup[]
  onChange: (view: TaskWorkspaceView) => void
  onTaskListChange: (taskListId: string) => void
  onCreateTaskList: (listGroupId?: string) => void
  onCreateTaskListGroup: () => void
  onMoveTaskList: (taskListId: string, listGroupId: string | null) => void
  onRenameTaskListGroup: (group: ApiTaskListGroup) => void
  onDeleteTaskListGroup: (group: ApiTaskListGroup) => void
  onShareTaskList?: (taskList: ApiTaskList) => void
  onRenameTaskList?: (taskList: ApiTaskList) => void
  onArchiveTaskList?: (taskList: ApiTaskList) => void
  onLeaveTaskList?: (taskList: ApiTaskList) => void
  onDeleteTaskList?: (taskList: ApiTaskList) => void
  onOpenArchivedTaskLists?: () => void
}) => {
  const { t } = useTranslation('tasks')
  const current = activeView(state)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
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
      active={state.taskList === taskList.id}
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
    <>
      <aside className={desktopNavCss} aria-label={t('workspace.navigation')}>
        <h1 className={navTitleCss}>{t('title')}</h1>
        <nav className={navListCss}>
          <p className={sectionLabelCss}>{t('workspace.quickAccess')}</p>
          {views.map((view) => (
            <button
              key={view}
              type="button"
              aria-current={
                state.taskList === 'all' && current === view
                  ? 'page'
                  : undefined
              }
              className={navButtonCss}
              data-active={
                state.taskList === 'all' && current === view ? true : undefined
              }
              onClick={() => onChange(view)}
            >
              <span className={navLabelCss}>
                {view === 'assigned' ? (
                  <RiUserLine size={18} />
                ) : view === 'created' ? (
                  <RiFileAddLine size={18} />
                ) : view === 'completed' ? (
                  <RiCheckboxCircleLine size={18} />
                ) : (
                  <RiListCheck3 size={18} />
                )}
                <span>{t(`workspace.views.${view}`)}</span>
              </span>
              {state.taskList === 'all' && current === view && (
                <span aria-label={t('workspace.resultCount', { count })}>
                  {count}
                </span>
              )}
            </button>
          ))}
          <div
            className={sectionHeaderCss}
            data-list-drop-target={draggedTaskListId ? true : undefined}
            onDragOver={allowListDrop}
            onDrop={(event) => dropList(event, null)}
            title={
              draggedTaskListId
                ? t('taskListGroups.moveToUngrouped')
                : undefined
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
                    {
                      value: 'archived',
                      label: (
                        <span className={taskNavigationMenuItemLabelCss}>
                          <RiHistoryLine size={16} />
                          {t('taskLists.archivedTitle')}
                        </span>
                      ),
                    },
                  ]}
                  onAction={(action) => {
                    if (action === 'list') onCreateTaskList()
                    if (action === 'group') onCreateTaskListGroup()
                    if (action === 'archived') onOpenArchivedTaskLists?.()
                  }}
                />
              </Menu>
            </div>
          </div>
          {taskLists.length === 0 && taskListGroups.length === 0 ? (
            <p className={emptyListsCss}>{t('taskLists.empty')}</p>
          ) : (
            <>
              {ungroupedLists.map(renderTaskList)}
              {taskListGroups.map((group) => {
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
            </>
          )}
        </nav>
      </aside>
      <div className={mobileNavCss}>
        <Select
          label={t('workspace.mobileView')}
          aria-label={t('workspace.mobileView')}
          items={[
            ...views.map((value) => ({
              value: `view:${value}`,
              label: t(`workspace.views.${value}`),
            })),
            ...taskLists.map((taskList) => ({
              value: `list:${taskList.id}`,
              label: taskList.list_group
                ? `${taskList.list_group.name} / ${taskList.name}`
                : taskList.name,
            })),
          ]}
          selectedKey={
            state.taskList === 'all'
              ? `view:${current}`
              : `list:${state.taskList}`
          }
          onSelectionChange={(key) => {
            const value = String(key)
            if (value.startsWith('list:')) {
              onTaskListChange(value.slice(5))
            } else {
              onChange(value.slice(5) as TaskWorkspaceView)
            }
          }}
        />
      </div>
    </>
  )
}

const desktopNavCss = css({
  display: { base: 'none', md: 'flex' },
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
})
const navLabelCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const mobileNavCss = css({
  display: { base: 'block', md: 'none' },
  padding: '0.75rem 1rem 0',
})
