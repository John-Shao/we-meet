import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiCheckboxCircleLine,
  RiFileAddLine,
  RiListCheck3,
  RiListCheck,
  RiUserLine,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type { ApiTaskList } from '../api/ApiTask'
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
  onChange,
  onTaskListChange,
  onCreateTaskList,
}: {
  state: TaskWorkspaceState
  count: number
  taskLists: ApiTaskList[]
  onChange: (view: TaskWorkspaceView) => void
  onTaskListChange: (taskListId: string) => void
  onCreateTaskList: () => void
}) => {
  const { t } = useTranslation('tasks')
  const current = activeView(state)
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
          <div className={sectionHeaderCss}>
            <span>{t('taskLists.title')}</span>
            <Button
              variant="tertiary"
              size="sm"
              aria-label={t('taskLists.create')}
              onPress={onCreateTaskList}
            >
              <RiAddLine size={17} />
            </Button>
          </div>
          {taskLists.length === 0 ? (
            <p className={emptyListsCss}>{t('taskLists.empty')}</p>
          ) : (
            taskLists.map((taskList) => (
              <button
                key={taskList.id}
                type="button"
                aria-current={
                  state.taskList === taskList.id ? 'page' : undefined
                }
                className={navButtonCss}
                data-active={state.taskList === taskList.id ? true : undefined}
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
            ))
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
              label: taskList.name,
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
