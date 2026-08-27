import { useTranslation } from 'react-i18next'
import { RiCheckLine, RiLoader4Line } from '@remixicon/react'

import { VisualOnlyTooltip } from '@/primitives/VisualOnlyTooltip'
import { css } from '@/styled-system/css'

import type { ApiTask, TaskStatus } from '../api/ApiTask'

export const TaskCompletionButton = ({
  task,
  status,
  pending = false,
  onToggle,
}: {
  task: ApiTask
  status: TaskStatus
  pending?: boolean
  onToggle: () => void
}) => {
  const { t } = useTranslation('tasks')
  const targetStatus = status === 'completed' ? 'todo' : 'completed'
  const actionLabel = t(`actions.to_${targetStatus}`)
  const accessibleLabel = task.can_update_status
    ? t(
        status === 'completed'
          ? 'workspace.quickReopen'
          : 'workspace.quickComplete',
        { title: task.title }
      )
    : `${t(`statuses.${status}`)}: ${task.title}`

  return (
    <span className={controlCss}>
      <VisualOnlyTooltip
        tooltip={task.can_update_status ? actionLabel : t(`statuses.${status}`)}
        ariaLabel={accessibleLabel}
      >
        <button
          type="button"
          className={buttonCss}
          data-status={status}
          data-pending={pending || undefined}
          aria-busy={pending || undefined}
          disabled={!task.can_update_status || pending}
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {pending ? (
            <RiLoader4Line aria-hidden="true" size={12} />
          ) : (
            status === 'completed' && (
              <RiCheckLine aria-hidden="true" size={10} />
            )
          )}
        </button>
      </VisualOnlyTooltip>
    </span>
  )
}

const controlCss = css({
  flexShrink: 0,
  '& > div': { display: 'flex' },
})

const buttonCss = css({
  width: '0.875rem',
  height: '0.875rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: '1px solid token(colors.greyscale.400)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.000',
  cursor: 'pointer',
  transition: 'border-color 120ms, background-color 120ms, box-shadow 120ms',
  '&:not(:disabled):hover': {
    borderColor: 'primary.500',
    boxShadow: '0 0 0 2px token(colors.primary.100)',
  },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '2px',
  },
  _disabled: { cursor: 'default', pointerEvents: 'none' },
  '&[data-status="completed"]': {
    borderColor: 'success.500',
    backgroundColor: 'success.500',
    '&:not(:disabled):hover': {
      borderColor: 'success.600',
      backgroundColor: 'success.600',
      boxShadow: '0 0 0 2px token(colors.success.100)',
    },
  },
  '&[data-pending] svg': {
    animation: 'rotate 700ms linear infinite',
  },
})
