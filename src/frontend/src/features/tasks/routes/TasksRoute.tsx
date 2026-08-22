import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'wouter'
import { useTranslation } from 'react-i18next'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { RequireAuth } from '@/components/RequireAuth'
import { ResizablePanel } from '@/components/ResizablePanel'
import { StateHint } from '@/components/StateHint'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  TaskPriorityFilter,
  TaskStatusFilter,
  TaskTimeFilter,
} from '../api/ApiTask'
import { useTaskLabels, useTasks } from '../api/fetchTasks'
import { TaskFilterToolbar } from '../components/TaskFilterToolbar'
import { TaskLabelManager } from '../components/TaskLabelManager'
import { TaskList } from '../components/TaskList'
import { CreateTaskPanel, TaskDetailPanel } from '../components/TaskSidePanel'
import { TaskWorkspaceNavigation } from '../components/TaskWorkspaceNavigation'
import {
  buildTaskWorkspaceSearch,
  parseTaskWorkspaceState,
  stateForView,
  stateWithStatus,
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
  const [creating, setCreating] = useState(false)
  const [labelManagerOpen, setLabelManagerOpen] = useState(false)
  const isNarrow = useIsNarrow()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const newButtonRef = useRef<HTMLButtonElement>(null)
  const { data: labels = [] } = useTaskLabels()
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
    state.label
  )
  const tasks = useMemo(
    () => data?.pages.flatMap((page) => page.results) || [],
    [data]
  )
  const count = data?.pages[0]?.count || 0
  const selectedTask = tasks.find((task) => task.id === state.task)
  const panelOpen = creating || Boolean(state.task)

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
    setCreating(false)
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

  const changeStatus = (status: TaskStatusFilter) => {
    setCreating(false)
    navigateState({ ...stateWithStatus(state, status), task: undefined })
  }

  const updateFilter = (
    patch: Partial<Pick<TaskWorkspaceState, 'time' | 'priority' | 'label'>>
  ) => {
    setCreating(false)
    navigateState({ ...state, ...patch, task: undefined })
  }

  const panel = creating ? (
    <CreateTaskPanel
      labels={labels}
      onClose={closePanel}
      onCreated={(task) => {
        setCreating(false)
        navigateState({ ...state, task: task.id })
      }}
    />
  ) : state.task ? (
    <TaskDetailPanel
      taskId={state.task}
      fallbackTask={selectedTask}
      labels={labels}
      onClose={closePanel}
    />
  ) : null

  const currentViewName =
    state.scope === 'all' && state.status === 'completed'
      ? t('workspace.views.completed')
      : t(`workspace.views.${state.scope}`)

  return (
    <div className={workspaceCss}>
      <div className={desktopNavigationHolderCss}>
        <TaskWorkspaceNavigation
          state={state}
          count={count}
          onChange={changeView}
        />
      </div>
      <main className={mainCss}>
        <div className={mobileNavigationHolderCss}>
          <TaskWorkspaceNavigation
            state={state}
            count={count}
            onChange={changeView}
          />
        </div>
        <header className={headerCss}>
          <div>
            <h1 className={headingCss}>{currentViewName}</h1>
            <p className={countCss}>{t('workspace.resultCount', { count })}</p>
          </div>
          <Button
            ref={newButtonRef}
            onPress={() => {
              navigateState({ ...state, task: undefined })
              setCreating(true)
            }}
          >
            {t('workspace.newTask')}
          </Button>
        </header>
        <TaskFilterToolbar
          state={state}
          labels={labels}
          onStatusChange={changeStatus}
          onTimeChange={(time: TaskTimeFilter) => updateFilter({ time })}
          onPriorityChange={(priority: TaskPriorityFilter) =>
            updateFilter({ priority })
          }
          onLabelChange={(label) => updateFilter({ label })}
          onClear={() =>
            navigateState({
              ...state,
              status: 'open',
              time: 'all',
              priority: 'all',
              label: 'all',
              task: undefined,
            })
          }
          onManageLabels={() => setLabelManagerOpen(true)}
        />
        <div className={listRegionCss}>
          {isLoading ? (
            <StateHint loading>{t('loading')}</StateHint>
          ) : error ? (
            <StateHint>{t('error')}</StateHint>
          ) : tasks.length === 0 ? (
            <StateHint>{t('empty')}</StateHint>
          ) : (
            <>
              <TaskList
                tasks={tasks}
                selectedTaskId={state.task}
                onOpen={(task) => {
                  setCreating(false)
                  navigateState({ ...state, task: task.id })
                }}
                registerRow={(taskId, element) => {
                  if (element) rowRefs.current.set(taskId, element)
                  else rowRefs.current.delete(taskId)
                }}
              />
              {hasNextPage && (
                <div className={loadMoreCss}>
                  <Button
                    variant="secondary"
                    loading={isFetchingNextPage}
                    onPress={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage
                      ? t('workspace.loadingMore')
                      : t('workspace.loadMore')}
                  </Button>
                </div>
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
      {labelManagerOpen && (
        <Modal
          ariaLabel={t('labels.manage')}
          onClose={() => setLabelManagerOpen(false)}
          maxWidth="720px"
        >
          <div className={modalHeaderCss}>
            <h2 className={modalTitleCss}>{t('labels.manage')}</h2>
            <ModalCloseButton
              label={t('workspace.closeLabelManager')}
              onClose={() => setLabelManagerOpen(false)}
            />
          </div>
          <div className={modalBodyCss}>
            <TaskLabelManager labels={labels} standalone />
          </div>
        </Modal>
      )}
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
  height: 'calc(100dvh - 64px)',
  minHeight: 0,
  display: 'flex',
  overflow: 'hidden',
  backgroundColor: 'greyscale.000',
})
const desktopNavigationHolderCss = css({
  display: { base: 'none', md: 'contents' },
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
const modalBodyCss = css({ padding: '1rem', overflowY: 'auto' })
