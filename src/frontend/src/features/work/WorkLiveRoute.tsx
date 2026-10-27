import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { css } from '@/styled-system/css'
import type { Intent, TaskSummary } from './contracts/api'
import type { SseConnection, WorkEvent } from './contracts/sse'
import {
  createWorkApiClient,
  subscribeTaskEvents,
  WorkApiError,
} from './api/client'

type View = 'all' | 'pending' | 'running' | 'awaiting_acceptance' | 'completed'
type AdminView = {
  seats: { total: number; active: number }
  quota: {
    enforcement: string
    limit_tokens: number
    reserved_tokens: number
    settled_tokens: number
  }
  audit_retention_days: number
}
type InboxView = {
  items: { task_id: string; type: string; title: string }[]
}
type InputView = { input_ref: string }
type PreviewView = { preview_hash: string }

const VIEW_LABEL: Record<View, string> = {
  all: '全部',
  pending: '待处理',
  running: '进行中',
  awaiting_acceptance: '待验收',
  completed: '已完成',
}
const STATE_LABEL: Record<string, string> = {
  open: '待开始',
  queued: '排队中',
  running: '进行中',
  awaiting_acceptance: '待验收',
  completed: '已完成',
  failed: '失败',
  run_canceled: '已取消',
  reconciling: '对账中',
  quota_exhausted: '配额不足',
  canceling: '取消中',
  canceled: '已取消',
  archived: '已归档',
}

const client = createWorkApiClient()
const newRequestId = () => crypto.randomUUID()

const page = css({
  maxWidth: '82rem',
  margin: '0 auto',
  padding: { base: '1rem', md: '2rem' },
  display: 'grid',
  gap: '1.25rem',
})
const header = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  gap: '1rem',
  flexWrap: 'wrap',
})
const title = css({
  fontSize: '1.6rem',
  fontWeight: '700',
  color: 'greyscale.900',
})
const muted = css({ fontSize: '0.85rem', color: 'greyscale.600' })
const grid = css({
  display: 'grid',
  gap: '1.25rem',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1.15fr) minmax(0, 1fr)' },
  alignItems: 'start',
})
const card = css({
  backgroundColor: 'surface.default',
  border: '1px solid',
  borderColor: 'greyscale.200',
  borderRadius: '12px',
  padding: '1rem',
  display: 'grid',
  gap: '0.75rem',
})
const label = css({
  fontSize: '0.8rem',
  fontWeight: '600',
  color: 'greyscale.700',
})
const field = css({ display: 'grid', gap: '0.35rem' })
const textarea = css({
  width: '100%',
  minHeight: '7rem',
  border: '1px solid',
  borderColor: 'greyscale.300',
  borderRadius: '8px',
  padding: '0.75rem',
  fontSize: '0.95rem',
  color: 'greyscale.900',
  backgroundColor: 'greyscale.000',
})
const select = css({
  border: '1px solid',
  borderColor: 'greyscale.300',
  borderRadius: '8px',
  padding: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.900',
})
const button = css({
  border: '1px solid',
  borderColor: 'primary.600',
  backgroundColor: 'primary.600',
  color: 'white',
  borderRadius: '8px',
  padding: '0.5rem 0.9rem',
  fontSize: '0.9rem',
  fontWeight: '600',
  cursor: 'pointer',
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
})
const ghost = css({
  border: '1px solid',
  borderColor: 'greyscale.300',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  borderRadius: '8px',
  padding: '0.4rem 0.75rem',
  fontSize: '0.85rem',
  cursor: 'pointer',
})
const tabs = css({ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' })
const tab = (active: boolean) =>
  css({
    border: '1px solid',
    borderColor: active ? 'primary.600' : 'greyscale.200',
    backgroundColor: active ? 'primary.100' : 'greyscale.000',
    color: active ? 'primary.700' : 'greyscale.700',
    borderRadius: '999px',
    padding: '0.3rem 0.7rem',
    fontSize: '0.8rem',
    cursor: 'pointer',
  })
const list = css({ display: 'grid', gap: '0.5rem' })
const item = (active: boolean) =>
  css({
    textAlign: 'left',
    border: '1px solid',
    borderColor: active ? 'primary.500' : 'greyscale.200',
    borderRadius: '10px',
    padding: '0.7rem',
    backgroundColor: active ? 'brand.50' : 'greyscale.000',
    display: 'grid',
    gap: '0.25rem',
    cursor: 'pointer',
  })
const row = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.5rem',
})
const badge = css({
  fontSize: '0.72rem',
  borderRadius: '999px',
  padding: '0.15rem 0.5rem',
  backgroundColor: 'brand.100',
  color: 'greyscale.800',
})
const actions = css({ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' })

const errorText = (error: unknown) =>
  error instanceof WorkApiError
    ? `${error.code}${error.correlationId ? ` · ${error.correlationId}` : ''}`
    : error instanceof Error
      ? error.message
      : String(error)

export const WorkLiveRoute = () => {
  const queryClient = useQueryClient()
  const [view, setView] = useState<View>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [template, setTemplate] = useState('tpl-report')
  const [mode, setMode] = useState<'ask_each' | 'auto_readonly'>('ask_each')
  const [notice, setNotice] = useState('')
  const lastEventId = useRef<Record<string, string>>({})

  const bootstrap = useQuery({
    queryKey: ['work', 'bootstrap'],
    queryFn: () => client.getBootstrap(),
  })
  const tasks = useQuery({
    queryKey: ['work', 'tasks', view],
    queryFn: () => client.listTasks({ view }),
  })
  const inbox = useQuery({
    queryKey: ['work', 'inbox'],
    queryFn: async () => (await client.listInbox()) as InboxView,
  })
  const isAdmin =
    bootstrap.data?.org.role === 'owner' || bootstrap.data?.org.role === 'admin'
  const overview = useQuery({
    queryKey: ['work', 'admin-overview'],
    queryFn: async () => (await client.getAdminOverview()) as AdminView,
    enabled: isAdmin,
    retry: false,
  })
  const selectedSummary = useMemo(
    () =>
      tasks.data?.items.find((task) => task.task_id === selectedId) ??
      tasks.data?.items[0] ??
      null,
    [tasks.data, selectedId]
  )
  const detail = useQuery({
    queryKey: ['work', 'task', selectedSummary?.task_id],
    queryFn: () => client.getTask(selectedSummary!.task_id),
    enabled: Boolean(selectedSummary?.task_id),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['work'] })

  const submit = useMutation({
    mutationFn: async (text: string) => {
      await client.getBootstrap()
      const input = (await client.createInput({
        client_request_id: newRequestId(),
        goal: text,
      })) as InputView
      const intent: Intent = {
        input_ref: input.input_ref,
        target: { kind: 'cloud', profile: 'text-v1' },
        template: { id: template, version: 1 },
        permission_mode: mode,
        output: { format: 'markdown' },
        connectors: [],
      }
      const preview = (await client.createTaskPreview({
        intent,
      })) as PreviewView
      return client.submitTask({
        client_request_id: newRequestId(),
        preview_hash: preview.preview_hash,
        intent,
      })
    },
    onSuccess: (result) => {
      setGoal('')
      setSelectedId(result.task.task_id)
      setNotice(`已提交「${result.task.title}」，Run ${result.run.state}`)
      void invalidate()
    },
    onError: (error) => setNotice(`提交失败：${errorText(error)}`),
  })

  const cancel = useMutation({
    mutationFn: async (task: TaskSummary) => {
      const runId = task.active_run_id || task.latest_run_id
      if (!runId) throw new Error('没有可取消的运行')
      return client.cancelRun(runId, {
        client_request_id: newRequestId(),
        reason: 'user_requested',
      })
    },
    onSuccess: () => {
      setNotice('已请求取消')
      void invalidate()
    },
    onError: (error) => setNotice(`取消失败：${errorText(error)}`),
  })

  const accept = useMutation({
    mutationFn: async (task: TaskSummary) => {
      if (!task.latest_artifact) throw new Error('还没有可采纳的成果')
      return client.acceptTask(task.task_id, {
        client_request_id: newRequestId(),
        expected_revision: task.revision,
        artifact_id: task.latest_artifact.artifact_id,
        version_no: task.latest_artifact.version_no,
      })
    },
    onSuccess: () => {
      setNotice('已采纳')
      void invalidate()
    },
    onError: (error) => setNotice(`采纳失败：${errorText(error)}`),
  })

  useEffect(() => {
    if (!selectedSummary?.task_id) return
    let closed = false
    let connection: SseConnection | undefined
    subscribeTaskEvents(selectedSummary.task_id, {
      lastEventId: lastEventId.current[selectedSummary.task_id],
      onEvent: (event: WorkEvent) => {
        lastEventId.current[selectedSummary.task_id] = event.event_id
        void invalidate()
      },
      onResyncRequired: () => {
        void invalidate()
      },
    })
      .then((opened) => {
        if (closed) opened.close()
        else connection = opened
      })
      .catch((error) => {
        if (!closed) setNotice(`事件流断开：${errorText(error)}`)
      })
    return () => {
      closed = true
      connection?.close()
    }
    // queryClient is stable; only re-subscribe when the task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSummary?.task_id])

  const quota = overview.data?.quota
  const ratio =
    quota && quota.limit_tokens > 0
      ? quota.settled_tokens / quota.limit_tokens
      : 0

  return (
    <div className={page}>
      <div className={header}>
        <div>
          <h1 className={title}>工作</h1>
          <p className={muted}>
            {bootstrap.data
              ? `${bootstrap.data.org.name || bootstrap.data.org.id} · 真实 API`
              : '连接 Work API…'}
          </p>
          {notice && <p className={muted}>{notice}</p>}
        </div>
        <div className={card} style={{ minWidth: '16rem' }}>
          <div className={row}>
            <span className={label}>配额</span>
            <span className={muted}>
              {quota
                ? `${quota.settled_tokens.toLocaleString()} / ${quota.limit_tokens.toLocaleString()}`
                : '—'}
            </span>
          </div>
          <div
            style={{
              height: '0.4rem',
              backgroundColor: '#eee',
              borderRadius: '999px',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(ratio * 100, 100)}%`,
                backgroundColor: '#4772fa',
                borderRadius: '999px',
              }}
            />
          </div>
          <span className={muted}>
            {quota?.enforcement === 'hard'
              ? '硬上限'
              : '软上限（客户自带账号）'}
          </span>
        </div>
      </div>

      {bootstrap.isError && (
        <div className={card}>
          <strong>无法连接 Work API：{errorText(bootstrap.error)}</strong>
          <span className={muted}>
            确认已登录、拥有 Work 席位，且后端已执行 `migrate work`。
          </span>
        </div>
      )}

      <div className={grid}>
        <section className={card} aria-label="新建工作">
          <h2 className={title} style={{ fontSize: '1rem' }}>
            新建工作
          </h2>
          <div className={field}>
            <label className={label} htmlFor="work-live-goal">
              目标
            </label>
            <textarea
              id="work-live-goal"
              className={textarea}
              maxLength={2000}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：整理本季度进展与风险，给出下季度计划"
            />
          </div>
          <div className={grid} style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className={field}>
              <label className={label} htmlFor="work-live-template">
                模板
              </label>
              <select
                id="work-live-template"
                className={select}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              >
                <option value="tpl-report">方案 / 报告</option>
                <option value="tpl-plan">计划 / 清单</option>
                <option value="tpl-summary">总结 / 纪要</option>
              </select>
            </div>
            <div className={field}>
              <label className={label} htmlFor="work-live-mode">
                权限模式
              </label>
              <select
                id="work-live-mode"
                className={select}
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as 'ask_each' | 'auto_readonly')
                }
              >
                <option value="ask_each">逐步确认</option>
                <option value="auto_readonly">只读自动</option>
              </select>
            </div>
          </div>
          <div className={actions}>
            <button
              type="button"
              className={button}
              disabled={submit.isPending || !goal.trim()}
              onClick={() => submit.mutate(goal)}
            >
              {submit.isPending ? '提交中…' : '提交任务'}
            </button>
          </div>
        </section>

        <section className={card} aria-label="我的工作">
          <div className={row}>
            <h2 className={title} style={{ fontSize: '1rem' }}>
              我的工作
            </h2>
            <button
              type="button"
              className={ghost}
              onClick={() => void tasks.refetch()}
            >
              刷新
            </button>
          </div>
          <div className={tabs}>
            {(Object.keys(VIEW_LABEL) as View[]).map((key) => (
              <button
                key={key}
                type="button"
                className={tab(view === key)}
                onClick={() => setView(key)}
              >
                {VIEW_LABEL[key]}
              </button>
            ))}
          </div>
          {tasks.isLoading && <span className={muted}>加载中…</span>}
          {tasks.isError && (
            <span className={muted}>加载失败：{errorText(tasks.error)}</span>
          )}
          <div className={list}>
            {tasks.data?.items.map((task) => (
              <button
                key={task.task_id}
                type="button"
                className={item(task.task_id === selectedSummary?.task_id)}
                onClick={() => setSelectedId(task.task_id)}
              >
                <div className={row}>
                  <strong className={label}>{task.title}</strong>
                  <span className={badge}>
                    {STATE_LABEL[task.display_state] || task.display_state}
                  </span>
                </div>
                <span className={muted}>
                  {task.permission_mode === 'ask_each'
                    ? '逐步确认'
                    : '只读自动'}{' '}
                  · rev {task.revision}
                </span>
              </button>
            ))}
            {tasks.data?.items.length === 0 && (
              <span className={muted}>这个视图里还没有工作。</span>
            )}
          </div>
        </section>
      </div>

      <div className={grid}>
        <section className={card} aria-label="任务工作区">
          <h2 className={title} style={{ fontSize: '1rem' }}>
            任务工作区
          </h2>
          {!selectedSummary ? (
            <span className={muted}>从右侧选择一条工作。</span>
          ) : (
            <>
              <div className={row}>
                <strong>{selectedSummary.title}</strong>
                <span className={badge}>
                  {STATE_LABEL[selectedSummary.display_state] ||
                    selectedSummary.display_state}
                </span>
              </div>
              <span className={muted}>
                目标：{detail.data?.goal || '加载中…'}
              </span>
              <span className={muted}>
                token：已结算{' '}
                {selectedSummary.quota.settled_tokens.toLocaleString()} · 已预留{' '}
                {selectedSummary.quota.reserved_tokens.toLocaleString()}
              </span>
              <span className={muted}>
                成果：
                {selectedSummary.latest_artifact
                  ? `v${selectedSummary.latest_artifact.version_no} · Markdown`
                  : '尚未生成'}
              </span>
              <div className={actions}>
                <button
                  type="button"
                  className={ghost}
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(selectedSummary)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={
                    accept.isPending || !selectedSummary.latest_artifact
                  }
                  onClick={() => accept.mutate(selectedSummary)}
                >
                  采纳
                </button>
              </div>
            </>
          )}
        </section>

        <section className={card} aria-label="需要你">
          <h2 className={title} style={{ fontSize: '1rem' }}>
            需要你
          </h2>
          {inbox.data?.items.length === 0 && (
            <span className={muted}>暂时没有待处理事项。</span>
          )}
          <div className={list}>
            {inbox.data?.items.map((entry) => (
              <button
                key={entry.task_id}
                type="button"
                className={item(entry.task_id === selectedSummary?.task_id)}
                onClick={() => setSelectedId(entry.task_id)}
              >
                <span className={label}>{entry.title}</span>
                <span className={muted}>
                  {entry.type === 'acceptance_required' ? '待验收' : entry.type}
                </span>
              </button>
            ))}
          </div>
          {isAdmin && overview.data && (
            <div className={card} style={{ backgroundColor: 'greyscale.50' }}>
              <strong className={label}>管理概览（只读）</strong>
              <span className={muted}>
                席位：{overview.data.seats.active} / {overview.data.seats.total}{' '}
                活跃
              </span>
              <span className={muted}>
                审计留存：{overview.data.audit_retention_days} 天
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
