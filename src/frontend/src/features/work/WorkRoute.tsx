import { useMemo, useState } from 'react'
import { css } from '@/styled-system/css'
import { WorkLiveRoute } from './WorkLiveRoute'
import {
  acceptTask,
  adminOverview,
  advanceTask,
  cancelTask,
  createTask,
  listTasks,
  quota,
  templates,
  type DisplayState,
  type MockTask,
} from './mock/mockClient'

const STATE_LABEL: Record<DisplayState, string> = {
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

type View = 'all' | 'pending' | 'running' | 'awaiting_acceptance' | 'completed'

const VIEW_LABEL: Record<View, string> = {
  all: '全部',
  pending: '待处理',
  running: '进行中',
  awaiting_acceptance: '待验收',
  completed: '已完成',
}

const page = css({
  maxWidth: '82rem',
  margin: '0 auto',
  padding: { base: '1rem', md: '2rem' },
  display: 'grid',
  gap: '1.25rem',
})

const header = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
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

const sectionTitle = css({
  fontSize: '1rem',
  fontWeight: '700',
  color: 'greyscale.900',
})
const textarea = css({
  width: '100%',
  minHeight: '7rem',
  resize: 'vertical',
  border: '1px solid',
  borderColor: 'greyscale.300',
  borderRadius: '8px',
  padding: '0.75rem',
  fontSize: '0.95rem',
  color: 'greyscale.900',
  backgroundColor: 'greyscale.000',
})
const field = css({ display: 'grid', gap: '0.35rem' })
const label = css({
  fontSize: '0.8rem',
  fontWeight: '600',
  color: 'greyscale.700',
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
})
const ghostButton = css({
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
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
})
const badge = (state: DisplayState) =>
  css({
    fontSize: '0.72rem',
    borderRadius: '999px',
    padding: '0.15rem 0.5rem',
    backgroundColor:
      state === 'quota_exhausted' || state === 'failed'
        ? 'danger.subtle'
        : state === 'completed'
          ? 'greyscale.100'
          : 'brand.100',
    color: 'greyscale.800',
  })
const actions = css({ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' })
const quotaBar = css({
  height: '0.4rem',
  backgroundColor: 'greyscale.100',
  borderRadius: '999px',
  overflow: 'hidden',
})
const quotaFill = (ratio: number) =>
  css({
    height: '100%',
    width: `${Math.min(ratio * 100, 100)}%`,
    backgroundColor: 'primary.500',
  })

const WorkMockRoute = () => {
  const [view, setView] = useState<View>('all')
  const [tasks, setTasks] = useState<MockTask[]>(() => listTasks('all'))
  const [selectedId, setSelectedId] = useState<string | null>(
    tasks[0]?.id ?? null
  )
  const [goal, setGoal] = useState('')
  const [template, setTemplate] = useState(templates[0].id)
  const [mode, setMode] = useState<'ask_each' | 'auto_readonly'>('ask_each')
  const [showPreview, setShowPreview] = useState(false)
  const [notice, setNotice] = useState(
    'Mock 模式：不会调用真实模型或写入数据库。'
  )

  const stats = adminOverview()
  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId]
  )
  const inboxItems = useMemo(
    () =>
      tasks
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
        })),
    [tasks]
  )

  const refresh = (nextView: View = view) => {
    const next = listTasks(nextView)
    setTasks(next)
    setSelectedId((current) =>
      current && next.some((task) => task.id === current)
        ? current
        : (next[0]?.id ?? null)
    )
  }

  const submit = () => {
    if (!goal.trim()) {
      setNotice('先写下要完成的目标。')
      return
    }
    const task = createTask(goal, mode)
    setGoal('')
    setShowPreview(false)
    setView('all')
    setTasks(listTasks('all'))
    setSelectedId(task.id)
    setNotice(`已创建「${task.title}」，Mock 状态为排队中。`)
  }

  const act = (action: 'advance' | 'cancel' | 'accept') => {
    if (!selected) return
    const next =
      action === 'advance'
        ? advanceTask(selected.id)
        : action === 'cancel'
          ? cancelTask(selected.id)
          : acceptTask(selected.id)
    refresh(view)
    setNotice(
      next
        ? `「${next.title}」→ ${STATE_LABEL[next.displayState]}`
        : '操作未执行'
    )
  }

  const quotaRatio =
    stats.quota.limitTokens === 0
      ? 0
      : stats.quota.settledTokens / stats.quota.limitTokens

  return (
    <div className={page}>
      <div className={header}>
        <div>
          <h1 className={title}>工作</h1>
          <p className={muted}>
            云端文本任务 · Mock 演示（E6 契约先行，未接真实 API）
          </p>
        </div>
        <div className={card} style={{ minWidth: '16rem' }}>
          <div className={row}>
            <span className={label}>本周期 token</span>
            <span className={muted}>
              {stats.quota.settledTokens.toLocaleString()} /{' '}
              {stats.quota.limitTokens.toLocaleString()}
            </span>
          </div>
          <div className={quotaBar}>
            <div className={quotaFill(quotaRatio)} />
          </div>
          <span className={muted}>
            执行位置：云端 · 客户自带账号 · 仅统计 token
          </span>
        </div>
      </div>

      <div className={grid}>
        <section className={card} aria-label="新建工作">
          <div className={row}>
            <h2 className={sectionTitle}>新建工作</h2>
            <span className={muted}>{notice}</span>
          </div>
          <div className={field}>
            <label className={label} htmlFor="work-goal">
              目标
            </label>
            <textarea
              id="work-goal"
              className={textarea}
              value={goal}
              maxLength={2000}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：把本季度项目进展整理成给管理层的复盘报告"
            />
          </div>
          <div className={grid} style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className={field}>
              <label className={label} htmlFor="work-template">
                模板
              </label>
              <select
                id="work-template"
                className={select}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              >
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={field}>
              <label className={label} htmlFor="work-mode">
                权限模式
              </label>
              <select
                id="work-mode"
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
              className={ghostButton}
              onClick={() => setShowPreview((value) => !value)}
            >
              {showPreview ? '收起边界' : '预览边界'}
            </button>
            <button type="button" className={button} onClick={submit}>
              提交任务
            </button>
          </div>
          {showPreview && (
            <div className={card} style={{ backgroundColor: 'brand.50' }}>
              <strong className={label}>本次任务边界</strong>
              <span className={muted}>执行位置：云端（cloud/text-v1）</span>
              <span className={muted}>
                数据：仅本次输入的文本；不访问本机、连接器或项目
              </span>
              <span className={muted}>成果：Markdown，可编辑、采纳并导出</span>
              <span className={muted}>
                token 上限：10,000（超出即受控失败）
              </span>
              <span className={muted}>
                配额：
                {quota.enforcement === 'soft'
                  ? '软上限（客户自带账号）'
                  : '硬上限'}
              </span>
            </div>
          )}
        </section>

        <section className={card} aria-label="我的工作">
          <div className={row}>
            <h2 className={sectionTitle}>我的工作</h2>
            <button
              type="button"
              className={ghostButton}
              onClick={() => refresh()}
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
                onClick={() => {
                  setView(key)
                  refresh(key)
                }}
              >
                {VIEW_LABEL[key]}
              </button>
            ))}
          </div>
          <div className={list}>
            {tasks.length === 0 && (
              <span className={muted}>这个视图里还没有工作。</span>
            )}
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={item(task.id === selectedId)}
                onClick={() => setSelectedId(task.id)}
              >
                <div className={row}>
                  <strong className={label}>{task.title}</strong>
                  <span className={badge(task.displayState)}>
                    {STATE_LABEL[task.displayState]}
                  </span>
                </div>
                <span className={muted}>
                  {task.permissionMode === 'ask_each' ? '逐步确认' : '只读自动'}{' '}
                  · rev {task.revised}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className={grid}>
        <section className={card} aria-label="任务工作区">
          <h2 className={sectionTitle}>任务工作区</h2>
          {!selected ? (
            <span className={muted}>从左侧选择一条工作。</span>
          ) : (
            <>
              <div className={row}>
                <strong style={{ fontSize: '1.05rem' }}>
                  {selected.title}
                </strong>
                <span className={badge(selected.displayState)}>
                  {STATE_LABEL[selected.displayState]}
                </span>
              </div>
              <span className={muted}>目标：{selected.goal}</span>
              <span className={muted}>
                token：已结算 {selected.quota.settled.toLocaleString()} · 已预留{' '}
                {selected.quota.reserved.toLocaleString()}
              </span>
              <span className={muted}>
                成果：
                {selected.artifactVersion
                  ? `v${selected.artifactVersion} · Markdown`
                  : '尚未生成'}
              </span>
              <div className={actions}>
                <button
                  type="button"
                  className={ghostButton}
                  onClick={() => act('advance')}
                >
                  模拟执行
                </button>
                <button
                  type="button"
                  className={ghostButton}
                  onClick={() => act('cancel')}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={button}
                  onClick={() => act('accept')}
                >
                  采纳
                </button>
              </div>
            </>
          )}
        </section>

        <section className={card} aria-label="需要你">
          <h2 className={sectionTitle}>需要你</h2>
          {inboxItems.length === 0 && (
            <span className={muted}>暂时没有待处理事项。</span>
          )}
          <div className={list}>
            {inboxItems.map((inboxItem) => (
              <button
                key={inboxItem.taskId}
                type="button"
                className={item(inboxItem.taskId === selectedId)}
                onClick={() => setSelectedId(inboxItem.taskId)}
              >
                <span className={label}>{inboxItem.title}</span>
                <span className={muted}>
                  {inboxItem.type === 'acceptance_required'
                    ? '待验收'
                    : inboxItem.type === 'failed'
                      ? '失败'
                      : '对账中'}
                </span>
              </button>
            ))}
          </div>
          <div className={card} style={{ backgroundColor: 'greyscale.50' }}>
            <strong className={label}>管理概览（只读）</strong>
            <span className={muted}>
              席位：{stats.seats.active} / {stats.seats.total} 活跃
            </span>
            <span className={muted}>
              配额执行：
              {stats.quota.enforcement === 'soft' ? '软上限' : '硬上限'}
            </span>
            <span className={muted}>
              审计留存：{stats.auditRetentionDays} 天
            </span>
            <span className={muted}>
              大模型接入：
              {stats.providerConfigured ? '已配置（脱敏）' : '未配置'}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

export const WorkRoute = () => {
  const mode = (import.meta.env as Record<string, string | undefined>)
    .VITE_WORK_API_MODE
  return mode === 'live' ? <WorkLiveRoute /> : <WorkMockRoute />
}
