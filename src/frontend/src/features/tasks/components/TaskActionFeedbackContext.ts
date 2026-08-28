import { createContext, useContext } from 'react'

import type { PatchTaskPayload } from '../api/ApiTask'

export type TaskFeedbackKind =
  | 'completed'
  | 'reopened'
  | 'assigneesUpdated'
  | 'moved'

export type TaskActionFeedback = {
  notifyAction: (action: {
    taskId: string
    title: string
    kind: TaskFeedbackKind
    undoPatch?: PatchTaskPayload
  }) => void
  notifyFailure: (task: { taskId: string; title: string }) => void
  notifySaveState: (status: {
    taskId: string
    state: 'saving' | 'saved'
  }) => void
}

const noop = () => undefined
export const TaskActionFeedbackContext = createContext<TaskActionFeedback>({
  notifyAction: noop,
  notifyFailure: noop,
  notifySaveState: noop,
})

export const useTaskActionFeedback = () => useContext(TaskActionFeedbackContext)
