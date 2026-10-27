/** E6 UI state contract: one server-projected display state per task. */

import type { DisplayState } from './api'

export type TaskView =
  | 'pending'
  | 'running'
  | 'awaiting_acceptance'
  | 'completed'
  | 'all'

export interface StateAction {
  id: 'open_task' | 'cancel' | 'view_quota' | 'retry' | 'accept' | 'export'
  enabled: boolean
}

const ACTIONS: Record<DisplayState, StateAction['id'][]> = {
  open: ['open_task'],
  queued: ['open_task', 'cancel'],
  running: ['open_task', 'cancel'],
  awaiting_acceptance: ['open_task', 'accept', 'export'],
  completed: ['open_task', 'export'],
  failed: ['open_task', 'retry'],
  run_canceled: ['open_task', 'retry'],
  reconciling: ['open_task'],
  quota_exhausted: ['open_task', 'view_quota', 'cancel'],
  canceling: ['open_task'],
  canceled: ['open_task'],
  archived: ['open_task'],
}

export function actionsFor(state: DisplayState): StateAction[] {
  return ACTIONS[state].map((id) => ({ id, enabled: true }))
}

export function viewFor(state: DisplayState): Exclude<TaskView, 'all'> | null {
  if (['failed', 'reconciling', 'run_canceled'].includes(state))
    return 'pending'
  if (['queued', 'running', 'canceling', 'quota_exhausted'].includes(state))
    return 'running'
  if (state === 'awaiting_acceptance') return 'awaiting_acceptance'
  if (state === 'completed') return 'completed'
  return null
}
