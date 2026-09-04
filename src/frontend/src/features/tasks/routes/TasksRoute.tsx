import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useSearchParams } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiBarChartBoxLine,
  RiFilterOffLine,
  RiInbox2Line,
  RiKanbanView2,
  RiListCheck3,
  RiRefreshLine,
  RiSettings3Line,
} from '@remixicon/react'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { RequireAuth } from '@/components/RequireAuth'
import { ResizablePanel } from '@/components/ResizablePanel'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { css } from '@/styled-system/css'
import { openSystemSettings } from '@/stores/systemSettings'

import type {
  ApiTask,
  ApiTaskGroup,
  ApiTaskList,
  ApiTaskListGroup,
  TaskColumnId,
  TaskOrdering,
  TaskPriorityFilter,
  TaskStatusFilter,
  TaskTimeFilter,
} from '../api/ApiTask'
import {
  useDeleteTask,
  useDeleteTaskGroup,
  useDeleteTaskListGroup,
  useLeaveTaskList,
  useMoveTaskListToGroup,
  useStandaloneTaskCount,
  useTask,
  useTaskListGroups,
  useTaskLists,
  useTaskGroups,
  useTaskSettings,
  useTaskStatistics,
  useUpdateTaskList,
  useUpdateTaskGroup,
  useTasks,
} from '../api/fetchTasks'
import { TaskAnalytics } from '../components/TaskAnalytics'
import { TaskActionFeedbackProvider } from '../components/TaskActionFeedback'
import { TaskActivityDialog } from '../components/TaskActivityDialog'
import { TaskBoard } from '../components/TaskBoard'
import { TaskFilterToolbar } from '../components/TaskFilterToolbar'
import { TaskGroupForm } from '../components/TaskGroupForm'
import { TaskGroupManager } from '../components/TaskGroupManager'
import { TaskGroupRenameForm } from '../components/TaskGroupRenameForm'
import { TaskList } from '../components/TaskList'
import {
  TaskBoardSkeleton,
  TaskListSkeleton,
} from '../components/TaskSkeletons'
import { TaskShareDialog } from '../components/TaskShareDialog'
import { TaskListGroupForm } from '../components/TaskListGroupForm'
import { TaskListGroupRenameForm } from '../components/TaskListGroupRenameForm'
import { TaskListManager } from '../components/TaskListManager'
import {
  ArchivedTaskListsDialog,
  TaskListDeleteDialog,
  TaskListRenameDialog,
  TaskListSharingDialog,
} from '../components/TaskListDialogs'
import { CreateTaskPanel, TaskDetailPanel } from '../components/TaskSidePanel'
import { TaskWorkspaceNavigation } from '../components/TaskWorkspaceNavigation'
import {
  buildTaskWorkspaceSearch,
  effectiveTaskColumns,
  hasActiveTaskFilters,
  parseTaskWorkspaceState,
  stateForTaskGroup,
  stateForView,
  stateForTaskList,
  stateWithStatus,
  stateWithTaskWorkspacePreferences,
  taskColumnViewKey,
  taskPreferencesViewKey,
  taskWorkspacePreferences,
  type TaskWorkspaceMode,
  type TaskWorkspacePreferences,
  type TaskWorkspaceState,
  type TaskWorkspaceView,
} from '../taskWorkspaceState'

export const TasksRoute = () => (
  <RequireAuth>
    <Screen footer={false}>
      <TaskActionFeedbackProvider>
        <TasksAuthenticated />
      </TaskActionFeedbackProvider>
    </Screen>
  </RequireAuth>
)

const TasksAuthenticated = () => {
  const { t } = useTranslation('tasks')
  const [, navigate] = useLocation()
  const [searchParams] = useSearchParams()
  const state = useMemo(
    () => parseTaskWorkspaceState(searchParams),
    [searchParams]
  )
  const sharedVia = state.sharedVia
  const [creating, setCreating] = useState(false)
  const [createGroupId, setCreateGroupId] = useState<string>()
  const [createParentTask, setCreateParentTask] = useState<ApiTask | null>(null)
  const [taskListManagerOpen, setTaskListManagerOpen] = useState(false)
  const [taskActivityOpen, setTaskActivityOpen] = useState(false)
  const [groupNotice, setGroupNotice] = useState('')
  const [taskListCreateGroupId, setTaskListCreateGroupId] = useState<string>()
  const [taskListGroupCreating, setTaskListGroupCreating] = useState(false)
  const [taskListSharing, setTaskListSharing] = useState<ApiTaskList | null>(
    null
  )
  const [taskSharing, setTaskSharing] = useState<ApiTask | null>(null)
  const [taskListRenaming, setTaskListRenaming] = useState<ApiTaskList | null>(
    null
  )
  const [taskListDeleting, setTaskListDeleting] = useState<ApiTaskList | null>(
    null
  )
  const [archivedTaskListsOpen, setArchivedTaskListsOpen] = useState(false)
  const [taskListGroupRenaming, setTaskListGroupRenaming] =
    useState<ApiTaskListGroup | null>(null)
  const [groupCreating, setGroupCreating] = useState(false)
  const [groupsManaging, setGroupsManaging] = useState(false)
  const [groupRenaming, setGroupRenaming] = useState<ApiTaskGroup | null>(null)
  const usesTakeoverDetail = useUsesTakeoverDetail()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const newButtonRef = useRef<HTMLButtonElement>(null)
  const createTitleRef = useRef<HTMLInputElement>(null)
  const groupNameRef = useRef<HTMLInputElement>(null)
  const groupRenameRef = useRef<HTMLInputElement>(null)
  const taskListGroupNameRef = useRef<HTMLInputElement>(null)
  const taskListGroupRenameRef = useRef<HTMLInputElement>(null)
  const viewColumnsRef = useRef(
    new Map<string, { columns: TaskColumnId[]; columnOrder: TaskColumnId[] }>()
  )
  const viewPreferencesRef = useRef(new Map<string, TaskWorkspacePreferences>())
  // Board and analytics force the status to "all". Keep the prior list status
  // per view so switching modes cannot leak another view's status filter.
  const lastListStatusRef = useRef(new Map<string, TaskStatusFilter>())
  const { confirm } = useConfirm()
  const deleteGroupMutation = useDeleteTaskGroup()
  const updateGroupMutation = useUpdateTaskGroup()
  const deleteTaskListGroupMutation = useDeleteTaskListGroup()
  const deleteTaskMutation = useDeleteTask()
  const moveTaskListMutation = useMoveTaskListToGroup()
  const updateTaskListMutation = useUpdateTaskList()
  const leaveTaskListMutation = useLeaveTaskList()
  const { data: taskLists = [] } = useTaskLists()
  const { data: taskGroups = [], isSuccess: taskGroupsLoaded } = useTaskGroups()
  const { data: taskListGroups = [] } = useTaskListGroups()
  const { data: standaloneTaskCountData } = useStandaloneTaskCount()
  const { data: taskSettings } = useTaskSettings()
  const { data: assignedStatistics } = useTaskStatistics(
    'assigned',
    'all',
    'all',
    'all'
  )
  const { data: followingStatistics } = useTaskStatistics(
    'following',
    'all',
    'all',
    'all'
  )
  const { data: createdStatistics } = useTaskStatistics(
    'created',
    'all',
    'all',
    'all'
  )
  const { data: allStatistics } = useTaskStatistics('all', 'all', 'all', 'all')
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useTasks(
    state.scope,
    state.status,
    state.time,
    state.priority,
    state.taskList,
    state.group,
    state.ordering
  )
  const { data: selectedTaskDetail } = useTask(state.task, sharedVia)
  const tasks = useMemo(
    () => data?.pages.flatMap((page) => page.results) || [],
    [data]
  )
  const listTasks = useMemo(
    () =>
      selectedTaskDetail &&
      !tasks.some((task) => task.id === selectedTaskDetail.id)
        ? [selectedTaskDetail, ...tasks]
        : tasks,
    [selectedTaskDetail, tasks]
  )
  const count = data?.pages[0]?.count || 0
  const navigationCounts = {
    assigned: assignedStatistics?.summary.open || 0,
    following: followingStatistics?.summary.open || 0,
    created: createdStatistics?.summary.open || 0,
    all: allStatistics?.summary.open || 0,
  }
  const standaloneTaskCount = standaloneTaskCountData?.count || 0
  const selectedTask =
    tasks.find((task) => task.id === state.task) || selectedTaskDetail
  const selectedTaskList = taskLists.find(
    (taskList) => taskList.id === state.taskList
  )
  const selectedTaskGroup = taskGroups.find(
    (taskGroup) => taskGroup.id === state.group
  )
  const panelOpen = Boolean(state.task)
  const filtersActive = hasActiveTaskFilters(state)
  const deleteGroup = async (group: ApiTaskGroup) => {
    if (!group.can_manage || !group.can_delete) return
    const accepted = await confirm({
      title: t('groups.deleteTitle'),
      message: t('groups.deleteDescription', { name: group.name }),
      confirmLabel: t('groups.delete'),
      danger: true,
    })
    if (!accepted) return
    try {
      await deleteGroupMutation.mutateAsync(group.id)
      if (state.group === group.id) {
        setGroupNotice(t('groups.invalidSelection'))
        navigateState(stateWithViewConfiguration(stateForView(state, 'all')))
      }
    } catch {
      // The mutation exposes its error while the manager remains available.
    }
  }

  const deleteTask = async (task: ApiTask) => {
    if (!task.can_delete) return
    const accepted = await confirm({
      title: t('actions.deleteTitle'),
      message:
        task.descendant_progress.total > 0
          ? t('actions.deleteSubtreeDescription', {
              title: task.title,
              count: task.descendant_progress.total,
            })
          : t('actions.deleteDescription', { title: task.title }),
      confirmLabel: t('actions.delete'),
      danger: true,
    })
    if (!accepted) return
    try {
      await deleteTaskMutation.mutateAsync({
        taskId: task.id,
        confirmSubtreeNodeCount: task.descendant_progress.total + 1,
      })
      if (state.task === task.id) {
        navigateState({ ...state, task: undefined }, { replace: true })
      }
    } catch {
      // Keep the task visible so the user can retry the action.
    }
  }

  const confirmCompleteWithOpenSubtasks = (task: ApiTask) =>
    confirm({
      title: t('actions.completeWithOpenSubtasksTitle'),
      message: t('actions.completeWithOpenSubtasksDescription', {
        count:
          task.descendant_progress.total - task.descendant_progress.completed,
      }),
      confirmLabel: t('actions.completeAnyway'),
    })

  const deleteTaskListGroup = async (group: ApiTaskListGroup) => {
    if (!group.can_manage) return
    const accepted = await confirm({
      title: t('taskListGroups.deleteTitle'),
      message: t('taskListGroups.deleteDescription', { name: group.name }),
      confirmLabel: t('taskListGroups.delete'),
      danger: true,
    })
    if (accepted) deleteTaskListGroupMutation.mutate(group.id)
  }

  const archiveTaskList = async (taskList: ApiTaskList) => {
    if (!taskList.can_archive) return
    const accepted = await confirm({
      title: t('taskLists.archiveTitle'),
      message: t('taskLists.archiveDescription', { name: taskList.name }),
      confirmLabel: t('taskLists.archive'),
    })
    if (!accepted) return
    await updateTaskListMutation.mutateAsync({
      taskListId: taskList.id,
      patch: { is_archived: true },
    })
    if (state.taskList === taskList.id) changeView('all')
  }

  const leaveTaskList = async (taskList: ApiTaskList) => {
    const accepted = await confirm({
      title: t('taskLists.leaveTitle'),
      message: t('taskLists.leaveDescription', { name: taskList.name }),
      confirmLabel: t('taskLists.leave'),
      danger: true,
    })
    if (!accepted) return
    await leaveTaskListMutation.mutateAsync(taskList.id)
    if (state.taskList === taskList.id) changeView('all')
  }

  const navigateState = (
    next: TaskWorkspaceState,
    options?: { replace?: boolean }
  ) => {
    navigate(`/tasks?${buildTaskWorkspaceSearch(next)}`, options)
  }

  const stateWithViewColumns = (next: TaskWorkspaceState) => {
    const configuration = viewColumnsRef.current.get(taskColumnViewKey(next))
    return configuration
      ? {
          ...next,
          columns: [...configuration.columns],
          columnOrder: [...configuration.columnOrder],
        }
      : next
  }

  const stateWithViewPreferences = (next: TaskWorkspaceState) => {
    return stateWithTaskWorkspacePreferences(
      next,
      viewPreferencesRef.current.get(taskPreferencesViewKey(next))
    )
  }

  const stateWithViewConfiguration = (next: TaskWorkspaceState) =>
    stateWithViewColumns(stateWithViewPreferences(next))

  const rememberCurrentViewPreferences = () => {
    viewPreferencesRef.current.set(
      taskPreferencesViewKey(state),
      taskWorkspacePreferences(state)
    )
  }

  const activeColumnViewKey = taskColumnViewKey(state)
  useEffect(() => {
    viewColumnsRef.current.set(activeColumnViewKey, {
      columns: [...state.columns],
      columnOrder: [...state.columnOrder],
    })
  }, [activeColumnViewKey, state.columns, state.columnOrder])

  const activePreferencesViewKey = taskPreferencesViewKey(state)
  useEffect(() => {
    viewPreferencesRef.current.set(
      activePreferencesViewKey,
      taskWorkspacePreferences(state)
    )
  }, [activePreferencesViewKey, state])

  const moveTaskGroup = async (group: ApiTaskGroup, direction: -1 | 1) => {
    const ordered = [...taskGroups].sort(
      (first, second) =>
        first.sort_order - second.sort_order ||
        first.created_at.localeCompare(second.created_at)
    )
    const index = ordered.findIndex((item) => item.id === group.id)
    const target = ordered[index + direction]
    if (!group.can_manage || !target?.can_manage) return
    try {
      await updateGroupMutation.mutateAsync({
        groupId: group.id,
        patch: { sort_order: target.sort_order },
      })
      await updateGroupMutation.mutateAsync({
        groupId: target.id,
        patch: { sort_order: group.sort_order },
      })
    } catch {
      // Invalidating the query restores the authoritative server order.
    }
  }

  const closePanel = () => {
    const returnTarget = state.task
      ? rowRefs.current.get(state.task)
      : newButtonRef.current
    navigateState({ ...state, task: undefined }, { replace: true })
    window.setTimeout(() => returnTarget?.focus(), 0)
  }

  useEffect(() => {
    if (!panelOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if ((event.target as HTMLElement | null)?.closest('[role="dialog"]'))
        return
      closePanel()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  })

  const changeView = (view: TaskWorkspaceView) => {
    setCreating(false)
    setGroupNotice('')
    rememberCurrentViewPreferences()
    navigateState(stateWithViewConfiguration(stateForView(state, view)))
  }

  const changeTaskList = (taskListId: string) => {
    setCreating(false)
    setGroupNotice('')
    rememberCurrentViewPreferences()
    navigateState(
      stateWithViewConfiguration(stateForTaskList(state, taskListId))
    )
  }

  const changeTaskGroup = (group: ApiTaskGroup) => {
    setCreating(false)
    setGroupNotice('')
    rememberCurrentViewPreferences()
    navigateState(stateForTaskGroup(state, group.id))
  }

  useEffect(() => {
    if (!taskGroupsLoaded || state.group === 'all' || selectedTaskGroup) return
    setGroupNotice(t('groups.invalidSelection'))
    navigateState(stateWithViewConfiguration(stateForView(state, 'all')), {
      replace: true,
    })
  }, [taskGroupsLoaded, selectedTaskGroup, state.group]) // eslint-disable-line react-hooks/exhaustive-deps

  const openTaskListManager = (listGroupId?: string) => {
    setTaskListCreateGroupId(listGroupId)
    setTaskListManagerOpen(true)
  }

  const changeMode = (mode: TaskWorkspaceMode) => {
    setCreating(false)
    setGroupNotice('')
    if (mode === state.mode) return
    const viewKey = taskPreferencesViewKey(state)
    if (mode === 'list') {
      navigateState({
        ...state,
        mode,
        status: lastListStatusRef.current.get(viewKey) ?? 'open',
        task: undefined,
      })
      return
    }
    lastListStatusRef.current.set(viewKey, state.status)
    navigateState({
      ...state,
      mode,
      status: 'all',
      time: mode === 'analytics' ? 'all' : state.time,
      task: undefined,
    })
  }

  const changeStatus = (status: TaskStatusFilter) => {
    setCreating(false)
    navigateState({ ...stateWithStatus(state, status), task: undefined })
  }

  const changeOrdering = (ordering: TaskOrdering) => {
    setCreating(false)
    navigateState({ ...state, ordering, task: undefined })
  }

  const updateFilter = (
    patch: Partial<Pick<TaskWorkspaceState, 'time' | 'priority'>>
  ) => {
    setCreating(false)
    navigateState({ ...state, ...patch, task: undefined })
  }

  const panel = state.task ? (
    <TaskDetailPanel
      taskId={state.task}
      fallbackTask={selectedTask}
      taskLists={taskLists}
      taskGroups={taskGroups}
      sharedVia={sharedVia}
      onCreateSubtask={(parentTask) => {
        setCreateParentTask(parentTask)
        setCreateGroupId(parentTask.group?.id)
        setCreating(true)
      }}
      onOpenSubtask={(subtask) => {
        setCreating(false)
        navigateState({
          ...state,
          scope: 'all',
          status: 'all',
          time: 'all',
          priority: 'all',
          taskList: 'all',
          mode: 'list',
          task: subtask.id,
        })
      }}
      onClose={closePanel}
    />
  ) : null

  const currentViewName = selectedTaskList
    ? selectedTaskList.name
    : state.taskList === 'unassigned'
      ? t('taskLists.standalone')
      : selectedTaskGroup
        ? selectedTaskGroup.name
        : t(`workspace.views.${state.scope}`)

  return (
    <div className={workspaceCss}>
      <div className={desktopNavigationHolderCss}>
        <ResizablePanel
          storageKey="we-meet:task-sidebar-width"
          defaultWidth={230}
          min={200}
          max={400}
        >
          <TaskWorkspaceNavigation
            state={state}
            navigationCounts={navigationCounts}
            taskLists={taskLists}
            taskListGroups={taskListGroups}
            taskGroups={taskGroups}
            standaloneTaskCount={standaloneTaskCount}
            onChange={changeView}
            onTaskListChange={changeTaskList}
            onCreateTaskList={openTaskListManager}
            onCreateTaskListGroup={() => setTaskListGroupCreating(true)}
            onSelectTaskGroup={changeTaskGroup}
            onCreateTaskGroup={() => setGroupCreating(true)}
            onManageTaskGroups={() => setGroupsManaging(true)}
            onMoveTaskList={(taskListId, listGroupId) =>
              moveTaskListMutation.mutate({ taskListId, listGroupId })
            }
            onRenameTaskListGroup={setTaskListGroupRenaming}
            onDeleteTaskListGroup={(group) => void deleteTaskListGroup(group)}
            onShareTaskList={setTaskListSharing}
            onRenameTaskList={setTaskListRenaming}
            onArchiveTaskList={(taskList) => void archiveTaskList(taskList)}
            onLeaveTaskList={(taskList) => void leaveTaskList(taskList)}
            onDeleteTaskList={setTaskListDeleting}
            onOpenArchivedTaskLists={() => setArchivedTaskListsOpen(true)}
            onOpenActivity={() => setTaskActivityOpen(true)}
          />
        </ResizablePanel>
      </div>
      <main className={mainCss}>
        <header className={headerCss}>
          <div>
            <h1 className={headingCss}>{currentViewName}</h1>
            <p className={countCss}>{t('workspace.resultCount', { count })}</p>
            {groupNotice && (
              <p role="status" className={groupNoticeCss}>
                {groupNotice}
              </p>
            )}
          </div>
          <div className={headerActionsCss}>
            <Button
              variant="tertiary"
              size="icon32"
              aria-label={t('settings.open')}
              onPress={() => openSystemSettings('tasks')}
            >
              <RiSettings3Line size={19} aria-hidden="true" />
            </Button>
            {state.mode === 'list' && state.grouping === 'custom' && (
              <Button
                variant="secondary"
                size="action"
                onPress={() => setGroupCreating(true)}
              >
                {t('groups.create')}
              </Button>
            )}
            <Button
              ref={newButtonRef}
              size="action"
              isDisabled={Boolean(
                selectedTaskList && !selectedTaskList.can_create_tasks
              )}
              onPress={() => {
                navigateState({ ...state, task: undefined })
                setCreateParentTask(null)
                setCreateGroupId(selectedTaskGroup?.id)
                setCreating(true)
              }}
            >
              {t('workspace.newTask')}
            </Button>
          </div>
        </header>
        <div
          className={modeTabsCss}
          role="tablist"
          aria-label={t('modes.label')}
        >
          {(['list', 'board', 'analytics'] as TaskWorkspaceMode[]).map(
            (mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={state.mode === mode}
                data-active={state.mode === mode || undefined}
                onClick={() => changeMode(mode)}
              >
                {mode === 'list' ? (
                  <RiListCheck3 size={17} />
                ) : mode === 'board' ? (
                  <RiKanbanView2 size={17} />
                ) : (
                  <RiBarChartBoxLine size={17} />
                )}
                {t(`modes.${mode}`)}
              </button>
            )
          )}
        </div>
        {state.mode !== 'analytics' && (
          <TaskFilterToolbar
            state={state}
            resultCount={count}
            onStatusChange={changeStatus}
            onTimeChange={(time: TaskTimeFilter) => updateFilter({ time })}
            onPriorityChange={(priority: TaskPriorityFilter) =>
              updateFilter({ priority })
            }
            onGroupingChange={(grouping) =>
              navigateState({ ...state, grouping, task: undefined })
            }
            onOrderingChange={changeOrdering}
            onColumnsChange={(columns, columnOrder = state.columnOrder) => {
              viewColumnsRef.current.set(taskColumnViewKey(state), {
                columns: [...columns],
                columnOrder: [...columnOrder],
              })
              navigateState({
                ...state,
                columns,
                columnOrder,
                task: undefined,
              })
            }}
            onClear={() =>
              navigateState({
                ...state,
                status: state.mode === 'board' ? 'all' : 'open',
                time: 'all',
                priority: 'all',
                task: undefined,
              })
            }
          />
        )}
        <div className={listRegionCss}>
          {state.mode === 'analytics' ? (
            <TaskAnalytics state={state} />
          ) : isLoading ? (
            state.mode === 'board' ? (
              <TaskBoardSkeleton label={t('loading')} />
            ) : (
              <TaskListSkeleton
                label={t('loading')}
                compact={panelOpen}
                grouped={state.grouping !== 'none'}
              />
            )
          ) : error ? (
            <TaskWorkspaceStateCard
              icon={<RiRefreshLine size={24} aria-hidden="true" />}
              title={t('workspace.errorTitle')}
              description={t('workspace.errorDescription')}
              actionLabel={t('workspace.retry')}
              onAction={() => void refetch()}
            />
          ) : listTasks.length === 0 && (filtersActive || !selectedTaskList) ? (
            <TaskWorkspaceStateCard
              icon={
                filtersActive ? (
                  <RiFilterOffLine size={24} aria-hidden="true" />
                ) : (
                  <RiInbox2Line size={24} aria-hidden="true" />
                )
              }
              title={
                filtersActive
                  ? t('workspace.emptyFilteredTitle')
                  : t('workspace.emptyTitle')
              }
              description={
                filtersActive
                  ? t('workspace.emptyFilteredDescription')
                  : t('workspace.emptyWorkspaceDescription')
              }
              actionLabel={
                filtersActive
                  ? t('workspace.clearFilters')
                  : t('workspace.newTask')
              }
              onAction={() => {
                if (filtersActive) {
                  navigateState({
                    ...state,
                    status: state.mode === 'board' ? 'all' : 'open',
                    time: 'all',
                    priority: 'all',
                    task: undefined,
                  })
                  return
                }
                setCreateParentTask(null)
                setCreateGroupId(selectedTaskGroup?.id)
                setCreating(true)
              }}
            />
          ) : state.mode === 'board' ? (
            <>
              <TaskBoard
                tasks={tasks}
                selectedTaskId={state.task}
                onOpen={(task) => {
                  setCreating(false)
                  navigateState({ ...state, task: task.id })
                }}
              />
              {hasNextPage && (
                <LoadMoreTasks
                  loading={isFetchingNextPage}
                  onLoad={() => void fetchNextPage()}
                />
              )}
            </>
          ) : (
            <>
              <TaskList
                tasks={listTasks}
                showOverdueMarker={taskSettings?.overdue_marker_enabled ?? true}
                compact={panelOpen}
                taskLists={taskLists}
                columns={effectiveTaskColumns(state)}
                grouping={state.grouping}
                ordering={state.ordering}
                onOrderingChange={changeOrdering}
                groups={taskGroups}
                selectedTaskId={state.task}
                onOpen={(task) => {
                  setCreating(false)
                  navigateState({ ...state, task: task.id })
                }}
                onShare={setTaskSharing}
                onDeleteTask={(task) => void deleteTask(task)}
                onConfirmCompleteWithOpenSubtasks={
                  confirmCompleteWithOpenSubtasks
                }
                registerRow={(taskId, element) => {
                  if (element) rowRefs.current.set(taskId, element)
                  else rowRefs.current.delete(taskId)
                }}
                onCreateTaskInGroup={
                  state.grouping === 'custom' &&
                  (!selectedTaskList || selectedTaskList.can_create_tasks)
                    ? (groupId) => {
                        setCreateParentTask(null)
                        setCreateGroupId(groupId)
                        setCreating(true)
                      }
                    : undefined
                }
                canManageGroups
                onRenameGroup={setGroupRenaming}
                onDeleteGroup={(group) => void deleteGroup(group)}
              />
              {hasNextPage && (
                <LoadMoreTasks
                  loading={isFetchingNextPage}
                  onLoad={() => void fetchNextPage()}
                />
              )}
            </>
          )}
        </div>
      </main>
      {panelOpen &&
        (usesTakeoverDetail ? (
          createPortal(
            <div className={takeoverPanelCss}>{panel}</div>,
            document.body
          )
        ) : (
          <ResizablePanel
            storageKey="we-meet-task-panel-width"
            defaultWidth={440}
            min={360}
            max={640}
            side="right"
          >
            {panel}
          </ResizablePanel>
        ))}
      {creating && (
        <Modal
          ariaLabel={t('workspace.createTitle')}
          onClose={() => {
            setCreating(false)
            setCreateParentTask(null)
          }}
          initialFocusRef={createTitleRef}
          maxWidth="560px"
          maxHeight="82vh"
        >
          <CreateTaskPanel
            taskLists={taskLists.filter(
              (taskList) =>
                taskList.can_create_tasks ||
                taskList.id === createParentTask?.task_list?.id
            )}
            taskGroups={taskGroups}
            defaultTaskListId={selectedTaskList?.id}
            defaultGroupId={createGroupId}
            parentTask={createParentTask || undefined}
            titleInputRef={createTitleRef}
            onClose={() => {
              setCreating(false)
              setCreateParentTask(null)
            }}
            onCreated={(task) => {
              setCreating(false)
              setCreateParentTask(null)
              navigateState({ ...state, task: task.id })
            }}
          />
        </Modal>
      )}
      {taskActivityOpen && (
        <TaskActivityDialog
          onClose={() => setTaskActivityOpen(false)}
          onOpenTask={(taskId) => {
            setTaskActivityOpen(false)
            setCreating(false)
            navigateState({ ...state, task: taskId })
          }}
        />
      )}
      {taskListManagerOpen && (
        <Modal
          ariaLabel={t('taskLists.create')}
          onClose={() => setTaskListManagerOpen(false)}
          maxWidth="560px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('taskLists.create')}</h2>
            <ModalCloseButton
              label={t('taskLists.closeManager')}
              onClose={() => setTaskListManagerOpen(false)}
            />
          </div>
          <TaskListManager
            taskListGroups={taskListGroups}
            defaultListGroupId={taskListCreateGroupId}
            onCancel={() => setTaskListManagerOpen(false)}
            onCreated={(taskList) => {
              setTaskListManagerOpen(false)
              changeTaskList(taskList.id)
            }}
          />
        </Modal>
      )}
      {taskListSharing && (
        <TaskListSharingDialog
          taskList={taskListSharing}
          onClose={() => setTaskListSharing(null)}
        />
      )}
      {taskSharing && (
        <TaskShareDialog
          task={taskSharing}
          onClose={() => setTaskSharing(null)}
        />
      )}
      {taskListRenaming && (
        <TaskListRenameDialog
          taskList={taskListRenaming}
          onClose={() => setTaskListRenaming(null)}
        />
      )}
      {taskListDeleting && (
        <TaskListDeleteDialog
          taskList={taskListDeleting}
          onClose={() => setTaskListDeleting(null)}
          onDeleted={() => {
            const deletedId = taskListDeleting.id
            setTaskListDeleting(null)
            if (state.taskList === deletedId) changeView('all')
          }}
        />
      )}
      {archivedTaskListsOpen && (
        <ArchivedTaskListsDialog
          onClose={() => setArchivedTaskListsOpen(false)}
        />
      )}
      {taskListGroupCreating && (
        <Modal
          ariaLabel={t('taskListGroups.create')}
          onClose={() => setTaskListGroupCreating(false)}
          initialFocusRef={taskListGroupNameRef}
          maxWidth="440px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('taskListGroups.create')}</h2>
            <ModalCloseButton
              label={t('taskListGroups.closeCreate')}
              onClose={() => setTaskListGroupCreating(false)}
            />
          </div>
          <TaskListGroupForm
            inputRef={taskListGroupNameRef}
            onCancel={() => setTaskListGroupCreating(false)}
            onCreated={() => setTaskListGroupCreating(false)}
          />
        </Modal>
      )}
      {taskListGroupRenaming && (
        <Modal
          ariaLabel={t('taskListGroups.rename')}
          onClose={() => setTaskListGroupRenaming(null)}
          initialFocusRef={taskListGroupRenameRef}
          maxWidth="440px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('taskListGroups.rename')}</h2>
            <ModalCloseButton
              label={t('taskListGroups.closeRename')}
              onClose={() => setTaskListGroupRenaming(null)}
            />
          </div>
          <TaskListGroupRenameForm
            group={taskListGroupRenaming}
            inputRef={taskListGroupRenameRef}
            onCancel={() => setTaskListGroupRenaming(null)}
            onRenamed={() => setTaskListGroupRenaming(null)}
          />
        </Modal>
      )}
      {groupCreating && (
        <Modal
          ariaLabel={t('groups.create')}
          onClose={() => setGroupCreating(false)}
          initialFocusRef={groupNameRef}
          maxWidth="440px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('groups.create')}</h2>
            <ModalCloseButton
              label={t('groups.closeCreate')}
              onClose={() => setGroupCreating(false)}
            />
          </div>
          <TaskGroupForm
            sortOrder={taskGroups.length}
            inputRef={groupNameRef}
            onCancel={() => setGroupCreating(false)}
            onCreated={() => setGroupCreating(false)}
          />
        </Modal>
      )}
      {groupsManaging && (
        <Modal
          ariaLabel={t('groups.manage')}
          onClose={() => setGroupsManaging(false)}
          maxWidth="640px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('groups.manage')}</h2>
            <ModalCloseButton
              label={t('groups.closeManager')}
              onClose={() => setGroupsManaging(false)}
            />
          </div>
          <TaskGroupManager
            groups={taskGroups}
            onCreate={() => {
              setGroupsManaging(false)
              setGroupCreating(true)
            }}
            onRename={(group) => {
              setGroupsManaging(false)
              setGroupRenaming(group)
            }}
            onDelete={(group) => void deleteGroup(group)}
            onMove={(group, direction) => void moveTaskGroup(group, direction)}
          />
        </Modal>
      )}
      {groupRenaming && (
        <Modal
          ariaLabel={t('groups.rename')}
          onClose={() => setGroupRenaming(null)}
          initialFocusRef={groupRenameRef}
          maxWidth="440px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('groups.rename')}</h2>
            <ModalCloseButton
              label={t('groups.closeRename')}
              onClose={() => setGroupRenaming(null)}
            />
          </div>
          <TaskGroupRenameForm
            group={groupRenaming}
            inputRef={groupRenameRef}
            onCancel={() => setGroupRenaming(null)}
            onRenamed={() => setGroupRenaming(null)}
          />
        </Modal>
      )}
    </div>
  )
}

const LoadMoreTasks = ({
  loading,
  onLoad,
}: {
  loading: boolean
  onLoad: () => void
}) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={loadMoreCss}>
      <Button variant="secondary" loading={loading} onPress={onLoad}>
        {loading ? t('workspace.loadingMore') : t('workspace.loadMore')}
      </Button>
    </div>
  )
}

const TaskWorkspaceStateCard = ({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ReactNode
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}) => (
  <div className={workspaceStateCss} role="status">
    <span className={workspaceStateIconCss}>{icon}</span>
    <h2>{title}</h2>
    <p>{description}</p>
    <Button variant="secondary" size="dense" onPress={onAction}>
      {actionLabel}
    </Button>
  </div>
)

const useUsesTakeoverDetail = () => {
  const [usesTakeoverDetail, setUsesTakeoverDetail] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 1439px)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1439px)')
    const update = () => setUsesTakeoverDetail(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return usesTakeoverDetail
}

const workspaceCss = css({
  width: '100%',
  height: '100%',
  minHeight: 0,
  display: 'flex',
  overflow: 'hidden',
  backgroundColor: 'greyscale.000',
})
const desktopNavigationHolderCss = css({
  display: 'block',
  height: '100%',
  flexShrink: 0,
})
const mainCss = css({
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
})
const headerCss = css({
  minHeight: '4rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
})
const headingCss = css({
  margin: 0,
  color: 'default.text',
  fontSize: '1.125rem',
  fontWeight: '600',
})
const countCss = css({
  margin: 0,
  color: 'default.subtle-text',
  fontSize: '0.75rem',
})
const groupNoticeCss = css({
  margin: '0.125rem 0 0',
  color: 'warning.subtle-text',
  fontSize: '0.75rem',
})
const headerActionsCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const modeTabsCss = css({
  minHeight: '2.75rem',
  display: 'flex',
  alignItems: 'end',
  gap: '1.25rem',
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& button': {
    height: '2.75rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    padding: 0,
    border: 0,
    borderBottom: '2px solid transparent',
    backgroundColor: 'transparent',
    color: 'greyscale.600',
    fontSize: '0.8125rem',
    cursor: 'pointer',
  },
  '& button[data-active]': {
    borderBottomColor: 'primary.500',
    color: 'primary.700',
    fontWeight: '500',
  },
})
const listRegionCss = css({ flex: 1, minHeight: 0, overflow: 'auto' })
const workspaceStateCss = css({
  minHeight: '18rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '2rem',
  textAlign: 'center',
  '& h2': {
    margin: '0.25rem 0 0',
    color: 'greyscale.900',
    fontSize: '1rem',
  },
  '& p': {
    maxWidth: '28rem',
    margin: 0,
    color: 'greyscale.600',
    fontSize: '0.8125rem',
  },
  '& button': { marginTop: '0.5rem' },
})
const workspaceStateIconCss = css({
  width: '3rem',
  height: '3rem',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '999px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.600',
})
const loadMoreCss = css({
  display: 'flex',
  justifyContent: 'center',
  padding: '1rem',
})
const takeoverPanelCss = css({
  position: 'fixed',
  inset: 0,
  zIndex: 'takeover',
  display: 'flex',
  justifyContent: 'center',
  backgroundColor: 'greyscale.50',
  '& > aside': {
    width: '100%',
    maxWidth: '960px',
    backgroundColor: 'greyscale.000',
    boxShadow: '0 0 0 1px token(colors.greyscale.200)',
  },
})
const modalHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const modalTitleCss = css({
  margin: 0,
  color: 'default.text',
  fontSize: '1rem',
})
