import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiBarChartBoxLine,
  RiKanbanView2,
  RiListCheck3,
} from '@remixicon/react'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { RequireAuth } from '@/components/RequireAuth'
import { ResizablePanel } from '@/components/ResizablePanel'
import { StateHint } from '@/components/StateHint'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { css } from '@/styled-system/css'

import type {
  ApiTask,
  ApiTaskGroup,
  ApiTaskList,
  ApiTaskListGroup,
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
  useUpdateTaskList,
  useTasks,
} from '../api/fetchTasks'
import { TaskAnalytics } from '../components/TaskAnalytics'
import { TaskBoard } from '../components/TaskBoard'
import { TaskFilterToolbar } from '../components/TaskFilterToolbar'
import { TaskGroupForm } from '../components/TaskGroupForm'
import { TaskGroupRenameForm } from '../components/TaskGroupRenameForm'
import { TaskList } from '../components/TaskList'
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
  parseTaskWorkspaceState,
  stateForView,
  stateForTaskList,
  stateWithStatus,
  type TaskWorkspaceMode,
  type TaskWorkspaceState,
  type TaskWorkspaceView,
} from '../taskWorkspaceState'

export const TasksRoute = () => (
  <RequireAuth>
    <Screen footer={false}>
      <TasksAuthenticated />
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
  const sharedVia = searchParams.get('shared_via') || undefined
  const [creating, setCreating] = useState(false)
  const [createGroupId, setCreateGroupId] = useState<string>()
  const [createParentTask, setCreateParentTask] = useState<ApiTask | null>(null)
  const [taskListManagerOpen, setTaskListManagerOpen] = useState(false)
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
  const [groupRenaming, setGroupRenaming] = useState<ApiTaskGroup | null>(null)
  const isNarrow = useIsNarrow()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const newButtonRef = useRef<HTMLButtonElement>(null)
  const createTitleRef = useRef<HTMLInputElement>(null)
  const groupNameRef = useRef<HTMLInputElement>(null)
  const groupRenameRef = useRef<HTMLInputElement>(null)
  const taskListGroupNameRef = useRef<HTMLInputElement>(null)
  const taskListGroupRenameRef = useRef<HTMLInputElement>(null)
  const { confirm } = useConfirm()
  const deleteGroupMutation = useDeleteTaskGroup()
  const deleteTaskListGroupMutation = useDeleteTaskListGroup()
  const deleteTaskMutation = useDeleteTask()
  const moveTaskListMutation = useMoveTaskListToGroup()
  const updateTaskListMutation = useUpdateTaskList()
  const leaveTaskListMutation = useLeaveTaskList()
  const { data: taskLists = [] } = useTaskLists()
  const { data: taskListGroups = [] } = useTaskListGroups()
  const { data: standaloneTaskCountData } = useStandaloneTaskCount()
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useTasks(
    state.scope,
    state.status,
    state.time,
    state.priority,
    state.taskList,
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
  const standaloneTaskCount = standaloneTaskCountData?.count || 0
  const selectedTask =
    tasks.find((task) => task.id === state.task) || selectedTaskDetail
  const selectedTaskList = taskLists.find(
    (taskList) => taskList.id === state.taskList
  )
  const panelOpen = Boolean(state.task)

  const deleteGroup = async (group: ApiTaskGroup) => {
    if (!group.can_delete) return
    const accepted = await confirm({
      title: t('groups.deleteTitle'),
      message: t('groups.deleteDescription', { name: group.name }),
      confirmLabel: t('groups.delete'),
      danger: true,
    })
    if (accepted) deleteGroupMutation.mutate(group.id)
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
    navigateState({ ...stateForView(state, view), task: undefined })
  }

  const changeTaskList = (taskListId: string) => {
    setCreating(false)
    navigateState(stateForTaskList(state, taskListId))
  }

  const openTaskListManager = (listGroupId?: string) => {
    setTaskListCreateGroupId(listGroupId)
    setTaskListManagerOpen(true)
  }

  const changeMode = (mode: TaskWorkspaceMode) => {
    setCreating(false)
    navigateState({
      ...state,
      mode,
      status: mode === 'list' ? state.status : 'all',
      time: mode === 'analytics' ? 'all' : state.time,
      task: undefined,
    })
  }

  const changeStatus = (status: TaskStatusFilter) => {
    setCreating(false)
    navigateState({ ...stateWithStatus(state, status), task: undefined })
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
      : state.scope === 'all' && state.status === 'completed'
        ? t('workspace.views.completed')
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
            count={count}
            taskLists={taskLists}
            taskListGroups={taskListGroups}
            standaloneTaskCount={standaloneTaskCount}
            onChange={changeView}
            onTaskListChange={changeTaskList}
            onCreateTaskList={openTaskListManager}
            onCreateTaskListGroup={() => setTaskListGroupCreating(true)}
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
          />
        </ResizablePanel>
      </div>
      <main className={mainCss}>
        <div className={mobileNavigationHolderCss}>
          <TaskWorkspaceNavigation
            state={state}
            count={count}
            taskLists={taskLists}
            taskListGroups={taskListGroups}
            standaloneTaskCount={standaloneTaskCount}
            onChange={changeView}
            onTaskListChange={changeTaskList}
            onCreateTaskList={openTaskListManager}
            onCreateTaskListGroup={() => setTaskListGroupCreating(true)}
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
          />
        </div>
        <header className={headerCss}>
          <div>
            <h1 className={headingCss}>{currentViewName}</h1>
            <p className={countCss}>{t('workspace.resultCount', { count })}</p>
          </div>
          <div className={headerActionsCss}>
            {selectedTaskList?.can_manage && state.mode === 'list' && (
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
                setCreateGroupId(undefined)
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
            onStatusChange={changeStatus}
            onTimeChange={(time: TaskTimeFilter) => updateFilter({ time })}
            onPriorityChange={(priority: TaskPriorityFilter) =>
              updateFilter({ priority })
            }
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
            <StateHint loading>{t('loading')}</StateHint>
          ) : error ? (
            <StateHint>{t('error')}</StateHint>
          ) : listTasks.length === 0 && !selectedTaskList ? (
            <StateHint>{t('empty')}</StateHint>
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
                taskLists={taskLists}
                ordering={state.ordering}
                onOrderingChange={(ordering) =>
                  navigateState({ ...state, ordering, task: undefined })
                }
                groups={selectedTaskList?.groups}
                grouped={Boolean(selectedTaskList)}
                selectedTaskId={state.task}
                onOpen={(task) => {
                  setCreating(false)
                  navigateState({ ...state, task: task.id })
                }}
                onShare={setTaskSharing}
                onDeleteTask={(task) => void deleteTask(task)}
                registerRow={(taskId, element) => {
                  if (element) rowRefs.current.set(taskId, element)
                  else rowRefs.current.delete(taskId)
                }}
                onCreateTaskInGroup={
                  selectedTaskList?.can_create_tasks
                    ? (groupId) => {
                        setCreateParentTask(null)
                        setCreateGroupId(groupId)
                        setCreating(true)
                      }
                    : undefined
                }
                canManageGroups={Boolean(selectedTaskList?.can_manage)}
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
        (isNarrow ? (
          <div className={mobilePanelCss}>{panel}</div>
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
      {groupCreating && selectedTaskList && (
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
            taskListId={selectedTaskList.id}
            inputRef={groupNameRef}
            onCancel={() => setGroupCreating(false)}
            onCreated={() => setGroupCreating(false)}
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

const useIsNarrow = () => {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 899px)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(max-width: 899px)')
    const update = () => setIsNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return isNarrow
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
  display: { base: 'none', md: 'block' },
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
const mobileNavigationHolderCss = css({
  display: { base: 'block', md: 'none' },
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
const loadMoreCss = css({
  display: 'flex',
  justifyContent: 'center',
  padding: '1rem',
})
const mobilePanelCss = css({
  position: 'fixed',
  inset: 0,
  zIndex: 'modal',
  backgroundColor: 'greyscale.000',
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
