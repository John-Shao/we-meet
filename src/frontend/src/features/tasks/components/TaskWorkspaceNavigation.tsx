import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArchiveLine,
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileAddLine,
  RiFolderAddLine,
  RiFolderLine,
  RiHistoryLine,
  RiListCheck3,
  RiListCheck,
  RiMoreLine,
  RiLogoutBoxRLine,
  RiShareLine,
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
  const knownGroupIds = new Set(taskListGroups.map((group) => group.id))
  const ungroupedLists = taskLists.filter(
    (taskList) =>
      !taskList.list_group || !knownGroupIds.has(taskList.list_group.id)
  )
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
    <div
      key={taskList.id}
      aria-current={state.taskList === taskList.id ? 'page' : undefined}
      className={taskListRowCss}
      data-active={state.taskList === taskList.id ? true : undefined}
    >
      <button
        type="button"
        draggable={taskList.can_manage}
        onDragStart={(event) => startListDrag(event, taskList)}
        onDragEnd={() => setDraggedTaskListId(undefined)}
        onClick={() => onTaskListChange(taskList.id)}
      >
        <span className={navLabelCss}>
          <RiListCheck
            size={18}
            data-color={taskList.color}
            className={listIconCss}
          />
          <span>{taskList.name}</span>
        </span>
        <span>{taskList.task_count}</span>
      </button>
      <div className={nodeActionsCss} data-node-actions>
        <Menu placement="bottom">
          <Button
            variant="tertiary"
            size="icon24"
            className={nodeActionButtonCss}
            aria-label={t('taskLists.more', { name: taskList.name })}
          >
            <RiMoreLine size={16} />
          </Button>
          <MenuList
            aria-label={t('taskLists.more', { name: taskList.name })}
            menuClassName={createMenuCss}
            items={[
              {
                value: 'share',
                label: (
                  <span className={menuItemLabelCss}>
                    <RiShareLine size={16} />
                    {t('taskLists.share')}
                  </span>
                ),
                isDisabled: !taskList.can_share,
              },
              {
                value: 'rename',
                label: (
                  <span className={menuItemLabelCss}>
                    <RiEditLine size={16} />
                    {t('taskLists.rename')}
                  </span>
                ),
                isDisabled: !taskList.can_manage,
              },
              {
                value: 'archive',
                label: (
                  <span className={menuItemLabelCss}>
                    <RiArchiveLine size={16} />
                    {t('taskLists.archive')}
                  </span>
                ),
                isDisabled: !taskList.can_archive,
              },
              {
                value: 'leave',
                label: (
                  <span className={menuItemLabelCss}>
                    <RiLogoutBoxRLine size={16} />
                    {t('taskLists.leave')}
                  </span>
                ),
              },
              ...(taskList.can_delete
                ? [
                    {
                      value: 'delete',
                      label: (
                        <span className={menuItemLabelCss}>
                          <RiDeleteBinLine size={16} />
                          {t('taskLists.delete')}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
            onAction={(action) => {
              if (action === 'share') onShareTaskList?.(taskList)
              if (action === 'rename') onRenameTaskList?.(taskList)
              if (action === 'archive') onArchiveTaskList?.(taskList)
              if (action === 'leave') onLeaveTaskList?.(taskList)
              if (action === 'delete') onDeleteTaskList?.(taskList)
            }}
          />
        </Menu>
      </div>
    </div>
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
              aria-current={current === view ? 'page' : undefined}
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
            <div className={persistentNodeActionsCss} data-node-actions>
              <Menu placement="bottom">
                <Button
                  variant="tertiary"
                  size="icon24"
                  className={nodeActionButtonCss}
                  aria-label={t('taskLists.title')}
                >
                  <RiAddLine size={17} />
                </Button>
                <MenuList
                  aria-label={t('taskLists.title')}
                  menuClassName={createMenuCss}
                  items={[
                    {
                      value: 'list',
                      label: (
                        <span className={menuItemLabelCss}>
                          <RiListCheck size={16} />
                          {t('taskLists.create')}
                        </span>
                      ),
                    },
                    {
                      value: 'group',
                      label: (
                        <span className={menuItemLabelCss}>
                          <RiFolderAddLine size={16} />
                          {t('taskListGroups.create')}
                        </span>
                      ),
                    },
                    {
                      value: 'archived',
                      label: (
                        <span className={menuItemLabelCss}>
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
                const lists = taskLists.filter(
                  (taskList) => taskList.list_group?.id === group.id
                )
                return (
                  <section
                    key={group.id}
                    className={listGroupCss}
                    onDragOver={allowListDrop}
                    onDrop={(event) => dropList(event, group.id)}
                  >
                    <div className={listGroupHeaderCss}>
                      <button
                        type="button"
                        aria-expanded={!collapsed}
                        aria-label={t(
                          collapsed
                            ? 'taskListGroups.expand'
                            : 'taskListGroups.collapse',
                          { name: group.name }
                        )}
                        onClick={() => toggleGroup(group.id)}
                      >
                        {collapsed ? (
                          <RiArrowRightSLine size={17} />
                        ) : (
                          <RiArrowDownSLine size={17} />
                        )}
                        <RiFolderLine size={16} />
                        <span>{group.name}</span>
                      </button>
                      <div className={nodeActionsCss} data-node-actions>
                        <Button
                          variant="tertiary"
                          size="icon24"
                          className={nodeActionButtonCss}
                          aria-label={t('taskListGroups.createListIn', {
                            name: group.name,
                          })}
                          onPress={() => onCreateTaskList(group.id)}
                        >
                          <RiAddLine size={16} />
                        </Button>
                        <Menu placement="bottom">
                          <Button
                            variant="tertiary"
                            size="icon24"
                            className={nodeActionButtonCss}
                            aria-label={t('taskListGroups.more', {
                              name: group.name,
                            })}
                          >
                            <RiMoreLine size={16} />
                          </Button>
                          <MenuList
                            aria-label={t('taskListGroups.more', {
                              name: group.name,
                            })}
                            menuClassName={createMenuCss}
                            items={[
                              {
                                value: 'create',
                                label: (
                                  <span className={menuItemLabelCss}>
                                    <RiAddLine size={16} />
                                    {t('taskLists.create')}
                                  </span>
                                ),
                              },
                              {
                                value: 'rename',
                                label: (
                                  <span className={menuItemLabelCss}>
                                    <RiEditLine size={16} />
                                    {t('taskListGroups.rename')}
                                  </span>
                                ),
                                isDisabled: !group.can_manage,
                              },
                              {
                                value: 'delete',
                                label: (
                                  <span className={menuItemLabelCss}>
                                    <RiDeleteBinLine size={16} />
                                    {t('taskListGroups.delete')}
                                  </span>
                                ),
                                isDisabled: !group.can_manage,
                              },
                            ]}
                            onAction={(action) => {
                              if (action === 'create')
                                onCreateTaskList(group.id)
                              if (action === 'rename')
                                onRenameTaskListGroup(group)
                              if (action === 'delete')
                                onDeleteTaskListGroup(group)
                            }}
                          />
                        </Menu>
                      </div>
                    </div>
                    {!collapsed && (
                      <div className={groupListsCss}>
                        {lists.length > 0 ? (
                          lists.map(renderTaskList)
                        ) : (
                          <p className={emptyGroupCss}>
                            {t('taskListGroups.empty')}
                          </p>
                        )}
                      </div>
                    )}
                  </section>
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
  _hover: {
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  _focusWithin: {
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  '&[data-list-drop-target]': {
    outline: '1px dashed token(colors.primary.400)',
    outlineOffset: '-2px',
    backgroundColor: 'selected.bg',
  },
})
const createMenuCss = css({ minWidth: '10rem' })
const menuItemLabelCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
})
const listGroupCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
})
const listGroupHeaderCss = css({
  minHeight: '2rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.25rem',
  marginTop: '0.25rem',
  color: 'greyscale.700',
  _hover: {
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  _focusWithin: {
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  '& > button:first-child': {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.25rem 0.375rem',
    border: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '0.8125rem',
    fontWeight: '600',
  },
  '& span': {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})
const groupListsCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  paddingLeft: '0.75rem',
})
const emptyGroupCss = css({
  margin: 0,
  padding: '0.25rem 0.625rem 0.5rem',
  color: 'greyscale.500',
  fontSize: '0.6875rem',
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
const taskListRowCss = css({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  borderRadius: '8px',
  color: 'greyscale.700',
  _hover: {
    backgroundColor: 'greyscale.100',
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  _focusWithin: {
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  '& > button:first-child': {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    border: 0,
    padding: '0.5rem 0.25rem 0.5rem 0.625rem',
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '0.875rem',
  },
  '&[data-active]': {
    backgroundColor: 'selected.bg',
    color: 'selected.text',
    fontWeight: '500',
  },
})
const nodeActionsCss = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  opacity: { base: 1, md: 0 },
  pointerEvents: { base: 'auto', md: 'none' },
  transition: 'opacity 120ms ease',
  _focusWithin: { opacity: 1, pointerEvents: 'auto' },
})
const persistentNodeActionsCss = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
})
const nodeActionButtonCss = css({
  backgroundColor: 'transparent!',
  boxShadow: 'none!',
  _hover: { backgroundColor: 'transparent!' },
  _focus: { backgroundColor: 'transparent!' },
  '&[data-pressed]': { backgroundColor: 'transparent!' },
})
const navLabelCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const listIconCss = css({
  color: 'primary.500',
  '&[data-color="grey"]': { color: 'greyscale.500' },
  '&[data-color="green"]': { color: 'success.500' },
  '&[data-color="yellow"]': { color: 'amber.500' },
  '&[data-color="orange"]': { color: 'amber.600' },
  '&[data-color="red"]': { color: 'danger.500' },
  '&[data-color="purple"]': { color: 'purple.500' },
})
const mobileNavCss = css({
  display: { base: 'block', md: 'none' },
  padding: '0.75rem 1rem 0',
})
