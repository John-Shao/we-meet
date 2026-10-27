/**
 * E6 mock Work client. Mirrors the D2/D5 contract so the UI can be built
 * before E3/E4 integration; no network, no persistence across reloads.
 */

export type DisplayState =
  | 'open'
  | 'queued'
  | 'running'
  | 'awaiting_acceptance'
  | 'completed'
  | 'failed'
  | 'run_canceled'
  | 'reconciling'
  | 'quota_exhausted'
  | 'canceling'
  | 'canceled'
  | 'archived'

export interface MockTask {
  id: string
  title: string
  goal: string
  displayState: DisplayState
  permissionMode: 'ask_each' | 'auto_readonly'
  revised: number
  updatedAt: string
  quota: { reserved: number; settled: number }
  pendingAcceptance: boolean
  artifactVersion: number | null
}

const now = () => new Date().toISOString()

let tasks: MockTask[] = [
  {
    id: 'demo-1',
    title: '季度复盘与下季度计划',
    goal: '整理本季度进展，输出下季度计划与风险。',
    displayState: 'awaiting_acceptance',
    permissionMode: 'ask_each',
    revised: 3,
    updatedAt: now(),
    quota: { reserved: 0, settled: 1840 },
    pendingAcceptance: true,
    artifactVersion: 1,
  },
  {
    id: 'demo-2',
    title: '客户访谈纪要',
    goal: '把访谈要点整理成结论、依据与待办。',
    displayState: 'running',
    permissionMode: 'auto_readonly',
    revised: 1,
    updatedAt: now(),
    quota: { reserved: 4200, settled: 0 },
    pendingAcceptance: false,
    artifactVersion: null,
  },
]

let quotaSettled = 1840
const quotaLimit = 100000

export const quota = {
  enforcement: 'soft' as const,
  limitTokens: quotaLimit,
  reservedTokens: 4200,
  settledTokens: quotaSettled,
}

export const templates = [
  { id: 'tpl-report', name: '方案 / 报告' },
  { id: 'tpl-plan', name: '计划 / 清单' },
  { id: 'tpl-summary', name: '总结 / 纪要' },
]

export function listTasks(
  view: 'all' | 'pending' | 'running' | 'awaiting_acceptance' | 'completed'
) {
  return tasks.filter((task) => {
    if (view === 'all') return true
    if (view === 'pending')
      return ['failed', 'reconciling', 'run_canceled'].includes(
        task.displayState
      )
    if (view === 'running')
      return ['queued', 'running', 'canceling', 'quota_exhausted'].includes(
        task.displayState
      )
    return task.displayState === view
  })
}

export function createTask(goal: string, mode: 'ask_each' | 'auto_readonly') {
  const task: MockTask = {
    id: `mock-${Date.now()}`,
    title: goal.trim().slice(0, 20) || '未命名任务',
    goal: goal.trim(),
    displayState: 'queued',
    permissionMode: mode,
    revised: 1,
    updatedAt: now(),
    quota: { reserved: 0, settled: 0 },
    pendingAcceptance: false,
    artifactVersion: null,
  }
  tasks = [task, ...tasks]
  return task
}

export function advanceTask(id: string): MockTask | undefined {
  tasks = tasks.map((task) => {
    if (task.id !== id) return task
    if (task.displayState === 'queued') {
      return {
        ...task,
        displayState: 'running',
        quota: { reserved: 4200, settled: 0 },
      }
    }
    if (
      task.displayState === 'running' ||
      task.displayState === 'quota_exhausted'
    ) {
      quotaSettled += 1200
      return {
        ...task,
        displayState: 'awaiting_acceptance',
        pendingAcceptance: true,
        artifactVersion: 1,
        quota: { reserved: 0, settled: 1200 },
        revised: task.revised + 1,
      }
    }
    return task
  })
  return tasks.find((task) => task.id === id)
}

export function cancelTask(id: string): MockTask | undefined {
  tasks = tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          displayState: 'run_canceled',
          pendingAcceptance: false,
          revised: task.revised + 1,
        }
      : task
  )
  return tasks.find((task) => task.id === id)
}

export function acceptTask(id: string): MockTask | undefined {
  tasks = tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          displayState: 'completed',
          pendingAcceptance: false,
          revised: task.revised + 1,
        }
      : task
  )
  return tasks.find((task) => task.id === id)
}

export function inbox() {
  return tasks
    .filter((task) =>
      ['awaiting_acceptance', 'failed', 'reconciling'].includes(
        task.displayState
      )
    )
    .map((task) => ({
      taskId: task.id,
      type:
        task.displayState === 'awaiting_acceptance'
          ? 'acceptance_required'
          : task.displayState,
      title: task.title,
      updatedAt: task.updatedAt,
    }))
}

export function adminOverview() {
  return {
    seats: { total: 8, active: 6 },
    quota: {
      enforcement: quota.enforcement,
      limitTokens: quota.limitTokens,
      reservedTokens: tasks.reduce((sum, task) => sum + task.quota.reserved, 0),
      settledTokens: quotaSettled,
    },
    providerConfigured: true,
    auditRetentionDays: 365,
  }
}
