import type { DragEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFolderLine,
  RiListCheck,
  RiLogoutBoxRLine,
  RiMoreLine,
  RiShareLine,
} from '@remixicon/react'

import { Button, Menu, MenuList } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskList, ApiTaskListGroup } from '../api/ApiTask'
import {
  taskNavigationActionButtonCss,
  taskNavigationActionsCss,
  taskNavigationMenuCss,
  taskNavigationMenuItemLabelCss,
} from './TaskWorkspaceNavigationStyles'

export const TaskListNavigationRow = ({
  taskList,
  active,
  onSelect,
  onDragStart,
  onDragEnd,
  onShare,
  onRename,
  onArchive,
  onLeave,
  onDelete,
}: {
  taskList: ApiTaskList
  active: boolean
  onSelect: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onShare?: () => void
  onRename?: () => void
  onArchive?: () => void
  onLeave?: () => void
  onDelete?: () => void
}) => {
  const { t } = useTranslation('tasks')

  return (
    <div className={taskListRowCss} data-active={active || undefined}>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        draggable={taskList.can_manage}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
      >
        <span className={navLabelCss}>
          <RiListCheck
            size={16}
            data-color={taskList.color}
            className={listIconCss}
          />
          <span>{taskList.name}</span>
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
            aria-label={t('taskLists.more', { name: taskList.name })}
          >
            <RiMoreLine size={16} />
          </Button>
          <MenuList
            aria-label={t('taskLists.more', { name: taskList.name })}
            menuClassName={taskNavigationMenuCss}
            items={[
              {
                value: 'share',
                label: (
                  <span className={taskNavigationMenuItemLabelCss}>
                    <RiShareLine size={16} />
                    {t('taskLists.share')}
                  </span>
                ),
                isDisabled: !taskList.can_share || !onShare,
              },
              {
                value: 'rename',
                label: (
                  <span className={taskNavigationMenuItemLabelCss}>
                    <RiEditLine size={16} />
                    {t('taskLists.rename')}
                  </span>
                ),
                isDisabled: !taskList.can_manage || !onRename,
              },
              {
                value: 'archive',
                label: (
                  <span className={taskNavigationMenuItemLabelCss}>
                    <RiArchiveLine size={16} />
                    {t('taskLists.archive')}
                  </span>
                ),
                isDisabled: !taskList.can_archive || !onArchive,
              },
              {
                value: 'leave',
                label: (
                  <span className={taskNavigationMenuItemLabelCss}>
                    <RiLogoutBoxRLine size={16} />
                    {t('taskLists.leave')}
                  </span>
                ),
                isDisabled: !taskList.can_remove || !onLeave,
              },
              ...(taskList.can_delete && onDelete
                ? [
                    {
                      value: 'delete',
                      label: (
                        <span className={taskNavigationMenuItemLabelCss}>
                          <RiDeleteBinLine size={16} />
                          {t('taskLists.delete')}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
            onAction={(action) => {
              if (action === 'share') onShare?.()
              if (action === 'rename') onRename?.()
              if (action === 'archive') onArchive?.()
              if (action === 'leave') onLeave?.()
              if (action === 'delete') onDelete?.()
            }}
          />
        </Menu>
      </div>
    </div>
  )
}

export const StandaloneTaskListNavigationRow = ({
  active,
  onSelect,
}: {
  active: boolean
  onSelect: () => void
}) => {
  const { t } = useTranslation('tasks')

  return (
    <div className={taskListRowCss} data-active={active || undefined}>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
      >
        <span className={navLabelCss}>
          <RiListCheck size={16} data-color="grey" className={listIconCss} />
          <span>{t('taskLists.standalone')}</span>
        </span>
      </button>
    </div>
  )
}

export const TaskListGroupNavigationNode = ({
  group,
  collapsed,
  isEmpty,
  children,
  onToggle,
  onDragOver,
  onDrop,
  onCreateTaskList,
  onRename,
  onDelete,
}: {
  group: ApiTaskListGroup
  collapsed: boolean
  isEmpty: boolean
  children: ReactNode
  onToggle: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onCreateTaskList: () => void
  onRename: () => void
  onDelete: () => void
}) => {
  const { t } = useTranslation('tasks')

  return (
    <section className={listGroupCss} onDragOver={onDragOver} onDrop={onDrop}>
      <div className={listGroupHeaderCss}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t(
            collapsed ? 'taskListGroups.expand' : 'taskListGroups.collapse',
            { name: group.name }
          )}
          onClick={onToggle}
        >
          {collapsed ? (
            <RiArrowRightSLine size={17} />
          ) : (
            <RiArrowDownSLine size={17} />
          )}
          <RiFolderLine size={16} />
          <span>{group.name}</span>
        </button>
        <div
          className={taskNavigationActionsCss({ visibility: 'conditional' })}
          data-node-actions
        >
          <Button
            variant="tertiary"
            size="icon24"
            className={taskNavigationActionButtonCss}
            aria-label={t('taskListGroups.createListIn', { name: group.name })}
            onPress={onCreateTaskList}
          >
            <RiAddLine size={16} />
          </Button>
          <Menu placement="bottom">
            <Button
              variant="tertiary"
              size="icon24"
              className={taskNavigationActionButtonCss}
              aria-label={t('taskListGroups.more', { name: group.name })}
            >
              <RiMoreLine size={16} />
            </Button>
            <MenuList
              aria-label={t('taskListGroups.more', { name: group.name })}
              menuClassName={taskNavigationMenuCss}
              items={[
                {
                  value: 'create',
                  label: (
                    <span className={taskNavigationMenuItemLabelCss}>
                      <RiAddLine size={16} />
                      {t('taskLists.create')}
                    </span>
                  ),
                },
                {
                  value: 'rename',
                  label: (
                    <span className={taskNavigationMenuItemLabelCss}>
                      <RiEditLine size={16} />
                      {t('taskListGroups.rename')}
                    </span>
                  ),
                  isDisabled: !group.can_manage,
                },
                {
                  value: 'delete',
                  label: (
                    <span className={taskNavigationMenuItemLabelCss}>
                      <RiDeleteBinLine size={16} />
                      {t('taskListGroups.delete')}
                    </span>
                  ),
                  isDisabled: !group.can_manage,
                },
              ]}
              onAction={(action) => {
                if (action === 'create') onCreateTaskList()
                if (action === 'rename') onRename()
                if (action === 'delete') onDelete()
              }}
            />
          </Menu>
        </div>
      </div>
      {!collapsed && (
        <div className={groupListsCss}>
          {isEmpty ? (
            <p className={emptyGroupCss}>{t('taskListGroups.empty')}</p>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  )
}

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
  '&:has(:focus-visible)': {
    backgroundColor: 'greyscale.100',
    '& [data-node-actions]': { opacity: 1, pointerEvents: 'auto' },
  },
  "&:has([aria-haspopup][aria-expanded='true'])": {
    backgroundColor: 'greyscale.100',
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

const listGroupCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
})

const listGroupHeaderCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.25rem',
  marginTop: '0.25rem',
  borderRadius: '8px',
  color: 'greyscale.700',
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
  '& > button:first-child': {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.5rem 0.25rem 0.5rem 0.625rem',
    border: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '0.875rem',
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
