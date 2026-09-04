import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileAddLine,
  RiFolderAddLine,
  RiHistoryLine,
  RiListCheck3,
  RiListCheck,
  RiBookmarkLine,
  RiMoreLine,
  RiSettings3Line,
  RiUserLine,
} from '@remixicon/react'

import { Button, Input, Menu, MenuList, Popover, Switch } from '@/primitives'
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
  ArchivedTaskListNavigationRow,
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
  archivedTaskLists = [],
  archivedTaskListsLoading = false,
  archivedTaskListsError = false,
  showArchivedTaskLists = false,
  taskListGroups,
  taskGroups = [],
  standaloneTaskCount,
  onChange,
  onTaskListChange,
  onCreateTaskList,
  onCreateTaskListGroup,
  onSelectTaskGroup,
  onCreateTaskGroup,
  onRenameTaskGroup,
  onDeleteTaskGroup,
  onMoveTaskGroup,
  taskGroupMutating = false,
  onMoveTaskList,
  onRenameTaskListGroup,
  onDeleteTaskListGroup,
  onShareTaskList,
  onRenameTaskList,
  onArchiveTaskList,
  onLeaveTaskList,
  onDeleteTaskList,
  onShowArchivedTaskListsChange,
  onRestoreArchivedTaskList,
  restoringArchivedTaskList = false,
  onOpenActivity,
}: {
  state: TaskWorkspaceState
  navigationCounts: Record<TaskWorkspaceView, number>
  taskLists: ApiTaskList[]
  archivedTaskLists?: ApiTaskList[]
  archivedTaskListsLoading?: boolean
  archivedTaskListsError?: boolean
  showArchivedTaskLists?: boolean
  taskListGroups: ApiTaskListGroup[]
  taskGroups?: ApiTaskGroup[]
  standaloneTaskCount: number
  onChange: (view: TaskWorkspaceView) => void
  onTaskListChange: (taskListId: string) => void
  onCreateTaskList: (listGroupId?: string) => void
  onCreateTaskListGroup: () => void
  onSelectTaskGroup?: (group: ApiTaskGroup) => void
  onCreateTaskGroup?: (name: string) => Promise<void> | void
  onRenameTaskGroup?: (
    group: ApiTaskGroup,
    name: string
  ) => Promise<void> | void
  onDeleteTaskGroup?: (group: ApiTaskGroup) => Promise<void> | void
  onMoveTaskGroup?: (
    group: ApiTaskGroup,
    direction: -1 | 1
  ) => Promise<void> | void
  taskGroupMutating?: boolean
  onMoveTaskList: (taskListId: string, listGroupId: string | null) => void
  onRenameTaskListGroup: (group: ApiTaskListGroup) => void
  onDeleteTaskListGroup: (group: ApiTaskListGroup) => void
  onShareTaskList?: (taskList: ApiTaskList) => void
  onRenameTaskList?: (taskList: ApiTaskList) => void
  onArchiveTaskList?: (taskList: ApiTaskList) => void
  onLeaveTaskList?: (taskList: ApiTaskList) => void
  onDeleteTaskList?: (taskList: ApiTaskList) => void
  onShowArchivedTaskListsChange?: (show: boolean) => void
  onRestoreArchivedTaskList?: (taskList: ApiTaskList) => void
  restoringArchivedTaskList?: boolean
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
  const [creatingTaskGroup, setCreatingTaskGroup] = useState(false)
  const [newTaskGroupName, setNewTaskGroupName] = useState('')
  const [taskGroupCreatePending, setTaskGroupCreatePending] = useState(false)
  const [taskGroupCreateError, setTaskGroupCreateError] = useState(false)
  const createTaskGroupInputRef = useRef<HTMLInputElement>(null)
  const displayedTaskLists = showArchivedTaskLists
    ? [...taskLists, ...archivedTaskLists]
    : taskLists
  const taskListsByGroup = new Map(
    taskListGroups.map((group) => [group.id, [] as ApiTaskList[]])
  )
  const ungroupedLists: ApiTaskList[] = []
  displayedTaskLists.forEach((taskList) => {
    const groupedLists = taskList.list_group
      ? taskListsByGroup.get(taskList.list_group.id)
      : undefined
    if (groupedLists) groupedLists.push(taskList)
    else ungroupedLists.push(taskList)
  })
  useEffect(() => {
    if (creatingTaskGroup) createTaskGroupInputRef.current?.focus()
  }, [creatingTaskGroup])
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
  const createTaskGroup = async (event: FormEvent) => {
    event.preventDefault()
    const name = newTaskGroupName.trim()
    if (!name || !onCreateTaskGroup || taskGroupCreatePending) return
    setTaskGroupCreatePending(true)
    setTaskGroupCreateError(false)
    try {
      await onCreateTaskGroup(name)
      setNewTaskGroupName('')
      setCreatingTaskGroup(false)
    } catch {
      setTaskGroupCreateError(true)
    } finally {
      setTaskGroupCreatePending(false)
    }
  }
  const renderTaskList = (taskList: ApiTaskList) =>
    taskList.is_archived ? (
      <ArchivedTaskListNavigationRow
        key={taskList.id}
        taskList={taskList}
        restoring={restoringArchivedTaskList}
        onRestore={
          onRestoreArchivedTaskList
            ? () => onRestoreArchivedTaskList(taskList)
            : undefined
        }
      />
    ) : (
      <TaskListNavigationRow
        key={taskList.id}
        taskList={taskList}
        active={state.group === 'all' && state.taskList === taskList.id}
        onSelect={() => onTaskListChange(taskList.id)}
        onDragStart={(event) => startListDrag(event, taskList)}
        onDragEnd={() => setDraggedTaskListId(undefined)}
        onShare={onShareTaskList ? () => onShareTaskList(taskList) : undefined}
        onRename={
          onRenameTaskList ? () => onRenameTaskList(taskList) : undefined
        }
        onArchive={
          onArchiveTaskList ? () => onArchiveTaskList(taskList) : undefined
        }
        onLeave={onLeaveTaskList ? () => onLeaveTaskList(taskList) : undefined}
        onDelete={
          onDeleteTaskList ? () => onDeleteTaskList(taskList) : undefined
        }
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
              aria-label={t('groups.create')}
              isDisabled={!onCreateTaskGroup || taskGroupMutating}
              onPress={() => {
                setTaskGroupCreateError(false)
                setCreatingTaskGroup(true)
              }}
            >
              <RiAddLine size={17} />
            </Button>
          </div>
        </div>
        {orderedTaskGroups.length === 0
          ? !creatingTaskGroup && (
              <p className={emptyListsCss}>{t('groups.emptyNavigation')}</p>
            )
          : orderedTaskGroups.map((group, index) => (
              <TaskGroupNavigationRow
                key={group.id}
                group={group}
                active={state.group === group.id}
                previousGroup={orderedTaskGroups[index - 1]}
                nextGroup={orderedTaskGroups[index + 1]}
                mutating={taskGroupMutating}
                onSelect={
                  onSelectTaskGroup ? () => onSelectTaskGroup(group) : undefined
                }
                onRename={onRenameTaskGroup}
                onDelete={onDeleteTaskGroup}
                onMove={onMoveTaskGroup}
              />
            ))}
        {creatingTaskGroup && (
          <form
            className={taskGroupInlineFormCss}
            onSubmit={(event) => void createTaskGroup(event)}
          >
            <Input
              ref={createTaskGroupInputRef}
              aria-label={t('groups.name')}
              value={newTaskGroupName}
              maxLength={80}
              disabled={taskGroupCreatePending}
              onChange={(event) => setNewTaskGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                setNewTaskGroupName('')
                setCreatingTaskGroup(false)
              }}
            />
            <Button
              type="submit"
              variant="tertiary"
              size="icon24"
              className={taskNavigationActionButtonCss}
              aria-label={t('groups.create')}
              loading={taskGroupCreatePending}
              isDisabled={!newTaskGroupName.trim()}
            >
              <RiCheckLine size={16} />
            </Button>
            <Button
              type="button"
              variant="tertiary"
              size="icon24"
              className={taskNavigationActionButtonCss}
              aria-label={t('workspace.createCancel')}
              isDisabled={taskGroupCreatePending}
              onPress={() => {
                setNewTaskGroupName('')
                setCreatingTaskGroup(false)
              }}
            >
              <RiCloseLine size={16} />
            </Button>
          </form>
        )}
        {taskGroupCreateError && (
          <p role="alert" className={taskGroupInlineErrorCss}>
            {t('groups.error')}
          </p>
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
            <Popover
              aria-label={t('taskLists.navigationSettings')}
              withArrow={false}
            >
              <Button
                variant="tertiary"
                size="icon24"
                className={taskNavigationActionButtonCss}
                aria-label={t('taskLists.navigationSettings')}
              >
                <RiSettings3Line size={16} />
              </Button>
              <div className={taskListSettingsCss}>
                <Switch
                  className={taskListSettingsSwitchCss}
                  isSelected={showArchivedTaskLists}
                  onChange={(selected) =>
                    onShowArchivedTaskListsChange?.(selected)
                  }
                >
                  {t('taskLists.showArchived')}
                </Switch>
              </div>
            </Popover>
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
        {displayedTaskLists.length === 0 &&
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
        {showArchivedTaskLists && archivedTaskListsLoading && (
          <p className={emptyListsCss}>{t('loading')}</p>
        )}
        {showArchivedTaskLists && archivedTaskListsError && (
          <p role="alert" className={emptyListsCss}>
            {t('taskLists.actionError')}
          </p>
        )}
      </nav>
    </aside>
  )
}

const TaskGroupNavigationRow = ({
  group,
  active,
  previousGroup,
  nextGroup,
  mutating,
  onSelect,
  onRename,
  onDelete,
  onMove,
}: {
  group: ApiTaskGroup
  active: boolean
  previousGroup?: ApiTaskGroup
  nextGroup?: ApiTaskGroup
  mutating: boolean
  onSelect?: () => void
  onRename?: (group: ApiTaskGroup, name: string) => Promise<void> | void
  onDelete?: (group: ApiTaskGroup) => Promise<void> | void
  onMove?: (group: ApiTaskGroup, direction: -1 | 1) => Promise<void> | void
}) => {
  const { t } = useTranslation('tasks')
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view')
  const [name, setName] = useState(group.name)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'rename') renameInputRef.current?.focus()
  }, [mode])

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName || nextName === group.name || !onRename || pending) return
    setPending(true)
    setError(false)
    try {
      await onRename(group, nextName)
      setMode('view')
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const deleteGroup = async () => {
    if (!onDelete || pending) return
    setPending(true)
    setError(false)
    try {
      await onDelete(group)
      setMode('view')
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const move = async (direction: -1 | 1) => {
    if (!onMove || pending) return
    setPending(true)
    setError(false)
    try {
      await onMove(group, direction)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const cancelInlineAction = () => {
    setName(group.name)
    setError(false)
    setMode('view')
  }

  return (
    <div className={taskGroupNodeCss} data-active={active || undefined}>
      {mode === 'rename' ? (
        <form
          className={taskGroupInlineFormCss}
          onSubmit={(event) => void rename(event)}
        >
          <Input
            ref={renameInputRef}
            aria-label={t('groups.name')}
            value={name}
            maxLength={80}
            disabled={pending || mutating}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancelInlineAction()
            }}
          />
          <Button
            type="submit"
            variant="tertiary"
            size="icon24"
            className={taskNavigationActionButtonCss}
            aria-label={t('groups.renameNamed', { name: group.name })}
            loading={pending}
            isDisabled={!name.trim() || name.trim() === group.name || mutating}
          >
            <RiCheckLine size={16} />
          </Button>
          <Button
            type="button"
            variant="tertiary"
            size="icon24"
            className={taskNavigationActionButtonCss}
            aria-label={t('workspace.createCancel')}
            isDisabled={pending || mutating}
            onPress={cancelInlineAction}
          >
            <RiCloseLine size={16} />
          </Button>
        </form>
      ) : mode === 'delete' ? (
        <div className={taskGroupDeleteConfirmationCss}>
          <p>{t('groups.deleteDescription', { name: group.name })}</p>
          <div>
            <Button
              size="dense"
              variant="secondary"
              isDisabled={pending || mutating}
              onPress={cancelInlineAction}
            >
              {t('workspace.createCancel')}
            </Button>
            <Button
              size="dense"
              variant="danger"
              loading={pending}
              isDisabled={mutating}
              onPress={() => void deleteGroup()}
            >
              {t('groups.delete')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={taskGroupRowCss}>
          <button
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={onSelect}
          >
            <span className={navLabelCss}>
              <RiListCheck size={18} />
              <span>{group.name}</span>
            </span>
            <span
              aria-label={t('groups.taskCount', { count: group.task_count })}
            >
              {group.task_count}
            </span>
          </button>
          <div
            className={taskNavigationActionsCss({ visibility: 'conditional' })}
            data-node-actions
          >
            <Menu placement="bottom">
              <Button
                variant="tertiary"
                size="icon24"
                className={taskNavigationActionButtonCss}
                aria-label={t('groups.moreNamed', { name: group.name })}
                isDisabled={pending || mutating}
              >
                <RiMoreLine size={16} />
              </Button>
              <MenuList
                aria-label={t('groups.moreNamed', { name: group.name })}
                menuClassName={taskNavigationMenuCss}
                items={[
                  {
                    value: 'move-up',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiArrowUpLine size={16} />
                        {t('groups.moveUpNamed', { name: group.name })}
                      </span>
                    ),
                    isDisabled:
                      !onMove ||
                      !group.can_manage ||
                      !previousGroup?.can_manage,
                  },
                  {
                    value: 'move-down',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiArrowDownLine size={16} />
                        {t('groups.moveDownNamed', { name: group.name })}
                      </span>
                    ),
                    isDisabled:
                      !onMove || !group.can_manage || !nextGroup?.can_manage,
                  },
                  {
                    value: 'rename',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiEditLine size={16} />
                        {t('groups.rename')}
                      </span>
                    ),
                    isDisabled: !onRename || !group.can_manage,
                  },
                  {
                    value: 'delete',
                    label: (
                      <span className={taskNavigationMenuItemLabelCss}>
                        <RiDeleteBinLine size={16} />
                        {t('groups.delete')}
                      </span>
                    ),
                    isDisabled:
                      !onDelete || !group.can_manage || !group.can_delete,
                  },
                ]}
                onAction={(action) => {
                  if (action === 'move-up') void move(-1)
                  if (action === 'move-down') void move(1)
                  if (action === 'rename') {
                    setName(group.name)
                    setError(false)
                    setMode('rename')
                  }
                  if (action === 'delete') {
                    setError(false)
                    setMode('delete')
                  }
                }}
              />
            </Menu>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className={taskGroupInlineErrorCss}>
          {mode === 'rename'
            ? t('groups.renameError')
            : t('groups.actionError')}
        </p>
      )}
    </div>
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
const taskListSettingsCss = css({
  width: '16rem',
})
const taskListSettingsSwitchCss = css({
  width: '100%',
  minHeight: '2.5rem',
  flexDirection: 'row-reverse',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingX: '0.5rem',
  fontSize: '0.8125rem',
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
const taskGroupNodeCss = css({
  display: 'flex',
  flexDirection: 'column',
  borderRadius: '8px',
  '&[data-active]': {
    backgroundColor: 'selected.bg',
    color: 'selected.text',
    fontWeight: '500',
  },
  _hover: {
    backgroundColor: 'greyscale.100',
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  '&:has(:focus-visible)': {
    backgroundColor: 'greyscale.100',
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  "&:has([aria-haspopup][aria-expanded='true'])": {
    backgroundColor: 'greyscale.100',
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
})
const taskGroupRowCss = css({
  minHeight: '2.5rem',
  display: 'flex',
  alignItems: 'center',
  '& > button:first-child': {
    minWidth: 0,
    flex: 1,
    alignSelf: 'stretch',
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
})
const taskGroupInlineFormCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.25rem 0.5rem',
  '& input': { minWidth: 0, flex: 1 },
})
const taskGroupDeleteConfirmationCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem',
  backgroundColor: 'danger.50',
  borderRadius: '8px',
  '& p': {
    margin: 0,
    color: 'danger.700',
    fontSize: '0.75rem',
    lineHeight: '1.125rem',
  },
  '& > div': {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.375rem',
  },
})
const taskGroupInlineErrorCss = css({
  margin: '0 0.5rem 0.25rem',
  color: 'danger.subtle-text',
  fontSize: '0.75rem',
})
