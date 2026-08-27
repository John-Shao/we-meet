import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useToast, useToastRegion } from '@react-aria/toast'
import {
  ToastQueue,
  useToastQueue,
  type QueuedToast,
  type ToastState,
} from '@react-stately/toast'
import { useTranslation } from 'react-i18next'
import {
  RiCheckboxCircleLine,
  RiCloseLine,
  RiErrorWarningLine,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import { usePatchTask } from '../api/fetchTasks'
import {
  TaskActionFeedbackContext,
  type TaskActionFeedback,
} from './TaskActionFeedbackContext'

type TaskActionToastData = {
  message: string
  intent: 'success' | 'error'
  dedupeKey: string
  actionLabel?: string
  closeLabel: string
  onAction?: () => void | Promise<void>
}

export const TaskActionFeedbackProvider = ({
  children,
}: {
  children: ReactNode
}) => {
  const { t } = useTranslation('tasks')
  const { mutateAsync: undoTask } = usePatchTask()
  const [queue] = useState(
    () => new ToastQueue<TaskActionToastData>({ maxVisibleToasts: 3 })
  )
  const state = useToastQueue(queue)

  const showToast = useCallback(
    (toast: TaskActionToastData) => {
      queue.visibleToasts.forEach((visibleToast) => {
        if (visibleToast.content.dedupeKey === toast.dedupeKey) {
          queue.close(visibleToast.key)
        }
      })
      queue.add(toast, { timeout: toast.onAction ? 7000 : 4000 })
    },
    [queue]
  )

  const notifyAction = useCallback<TaskActionFeedback['notifyAction']>(
    ({ taskId, title, kind, undoPatch }) => {
      const dedupeKey = `task:${taskId}`
      showToast({
        message: t(`feedback.${kind}`, { title }),
        intent: 'success',
        dedupeKey,
        closeLabel: t('feedback.close'),
        actionLabel: undoPatch ? t('feedback.undo') : undefined,
        onAction: undoPatch
          ? async () => {
              try {
                await undoTask({ taskId, patch: undoPatch })
                showToast({
                  message: t('feedback.undone', { title }),
                  intent: 'success',
                  dedupeKey,
                  closeLabel: t('feedback.close'),
                })
              } catch {
                showToast({
                  message: t('feedback.undoFailed', { title }),
                  intent: 'error',
                  dedupeKey,
                  closeLabel: t('feedback.close'),
                })
              }
            }
          : undefined,
      })
    },
    [showToast, t, undoTask]
  )

  const notifyFailure = useCallback<TaskActionFeedback['notifyFailure']>(
    ({ taskId, title }) => {
      showToast({
        message: t('feedback.updateFailed', { title }),
        intent: 'error',
        dedupeKey: `task:${taskId}`,
        closeLabel: t('feedback.close'),
      })
    },
    [showToast, t]
  )
  const contextValue = useMemo(
    () => ({ notifyAction, notifyFailure }),
    [notifyAction, notifyFailure]
  )

  return (
    <TaskActionFeedbackContext.Provider value={contextValue}>
      {children}
      {state.visibleToasts.length > 0 &&
        createPortal(<TaskToastRegion state={state} />, document.body)}
    </TaskActionFeedbackContext.Provider>
  )
}

const TaskToastRegion = ({
  state,
}: {
  state: ToastState<TaskActionToastData>
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const { regionProps } = useToastRegion({}, state, ref)
  return (
    <div {...regionProps} ref={ref} className={toastRegionCss}>
      {state.visibleToasts.map((toast) => (
        <TaskToast key={toast.key} toast={toast} state={state} />
      ))}
    </div>
  )
}

const TaskToast = ({
  toast,
  state,
}: {
  toast: QueuedToast<TaskActionToastData>
  state: ToastState<TaskActionToastData>
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const { toastProps, contentProps, closeButtonProps } = useToast(
    { toast },
    state,
    ref
  )
  const content = toast.content
  return (
    <div
      {...toastProps}
      ref={ref}
      className={toastCss}
      data-intent={content.intent}
    >
      <span className={toastIconCss} aria-hidden="true">
        {content.intent === 'error' ? (
          <RiErrorWarningLine size={18} />
        ) : (
          <RiCheckboxCircleLine size={18} />
        )}
      </span>
      <span {...contentProps} className={toastMessageCss}>
        {content.message}
      </span>
      {content.actionLabel && content.onAction && (
        <button
          type="button"
          className={toastActionCss}
          onClick={() => {
            state.close(toast.key)
            void content.onAction?.()
          }}
        >
          {content.actionLabel}
        </button>
      )}
      <Button
        square
        size="sm"
        invisible
        {...closeButtonProps}
        className={toastCloseCss}
        aria-label={content.closeLabel}
      >
        <RiCloseLine size={18} aria-hidden="true" />
      </Button>
    </div>
  )
}

const toastRegionCss = css({
  position: 'fixed',
  right: '1.5rem',
  bottom: '1.5rem',
  zIndex: 2100,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: '0.5rem',
  outline: 'none',
})
const toastCss = css({
  minWidth: '20rem',
  maxWidth: '32rem',
  minHeight: '3rem',
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
  alignItems: 'center',
  gap: '0.625rem',
  padding: '0.625rem 0.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '8px',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  '&[data-entering]': { animation: 'fade token(durations.normal)' },
  '&[data-exiting]': {
    animation: 'fade token(durations.fast) reverse ease-in',
  },
  '&[data-intent="error"]': { borderColor: 'danger.300' },
})
const toastIconCss = css({
  display: 'grid',
  placeItems: 'center',
  color: 'success.600',
  '[data-intent="error"] &': { color: 'danger.600' },
})
const toastMessageCss = css({
  minWidth: 0,
  fontSize: '0.8125rem',
  fontWeight: 'medium',
})
const toastActionCss = css({
  minHeight: '2rem',
  paddingX: '0.625rem',
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'primary.700',
  fontSize: '0.8125rem',
  fontWeight: 'semibold',
  cursor: 'pointer',
  _hover: { backgroundColor: 'primary.50' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '1px',
  },
})
const toastCloseCss = css({
  width: '2rem',
  height: '2rem',
  display: 'grid',
  placeItems: 'center',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'default.subtle-text',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
    outlineOffset: '1px',
  },
})
