import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getWorkCapabilities,
  listMaterials,
  workError,
  type Material,
} from '../api/materials'
import {
  cancelRun,
  createTask,
  downloadRunFile,
  getTask,
  listRunFiles,
  listTasks,
  retryTask,
  type WorkRun,
} from '../api/tasks'
import { RunArtifacts, RunProgress } from './Communication'

const active = (run?: WorkRun) =>
  run?.status === 'queued' || run?.status === 'running'
const cancelable = (run?: WorkRun) =>
  active(run) ||
  (run?.execution_target === 'local' && run.status === 'disconnected')
const states = {
  queued: '等待处理',
  running: '正在处理',
  succeeded: '成果已完成',
  failed: '处理失败',
  canceled: '已取消',
  disconnected: '设备断线，执行待确认',
}
const templates: Record<string, { title: string; goal: string }> = {
  new: { title: '新工作', goal: '' },
  weekly: {
    title: '周报',
    goal: '根据选定材料整理本周进展、风险和下周计划，输出 report.md。保留未确认和待验收状态，缺失信息单独列出。',
  },
  spreadsheet: {
    title: '表格分析',
    goal: '分析选定材料中的表格数据，说明清洗和统计口径，输出 report.md 及可复核的 CSV 或 JSON 结果。缺失信息单独列出。',
  },
}

export function AgentWork({
  ownerId,
  view,
}: {
  ownerId: string
  view: string
}) {
  const [params] = useSearchParams()
  const [, navigate] = useLocation()
  const taskId = params.get('task') || ''
  const client = useQueryClient()
  const root = ['work', ownerId]
  const [page, setPage] = useState(1)
  const [materialPage, setMaterialPage] = useState(1)
  const [selected, setSelected] = useState<Material[]>([])
  const [goal, setGoal] = useState(templates[view].goal)
  const [background, setBackground] = useState('')
  const [error, setError] = useState('')
  const key = useRef({ input: '', key: '' })
  const retryKey = useRef({ runId: '', key: '' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const capabilities = useQuery({
    queryKey: [...root, 'capabilities'],
    queryFn: getWorkCapabilities,
    retry: false,
  })
  const tasks = useQuery({
    queryKey: [...root, 'agent-tasks', page],
    queryFn: () => listTasks(page, 'office_agent'),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.results.some((t) => t.runs.some(cancelable)) ? 2500 : false,
  })
  const task = useQuery({
    queryKey: [...root, 'task', taskId],
    queryFn: () => getTask(taskId),
    enabled: !!taskId,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.runs.some(cancelable) ? 2000 : false,
  })
  const materials = useQuery({
    queryKey: [...root, 'materials', materialPage],
    queryFn: () => listMaterials(materialPage),
    retry: false,
  })
  const enabled = capabilities.data?.agent_enabled === true
  const refresh = () => client.invalidateQueries({ queryKey: root })
  const open = (id = '') =>
    navigate(`/work?view=${view}&execution=cloud${id ? `&task=${id}` : ''}`)
  const submit = useMutation({
    mutationFn: async () => {
      const data = {
        kind: 'office_agent' as const,
        recipient: '',
        goal,
        background,
        sources: selected.map(
          ({ id, checksum, parser_version, generation }) => ({
            id,
            checksum,
            parser_version,
            generation,
          })
        ),
      }
      const input = JSON.stringify(data)
      if (key.current.input !== input)
        key.current = { input, key: crypto.randomUUID() }
      const controller = new AbortController()
      abort.current = controller
      const result = await createTask(data, key.current.key, controller.signal)
      if (!controller.signal.aborted) {
        void refresh()
        open(result.id)
      }
    },
    onError: (e) => {
      if (!abort.current?.signal.aborted) setError(workError(e))
    },
  })
  const run = task.data?.runs.at(-1)
  const command = useMutation({
    mutationFn: (kind: 'cancel' | 'retry') => {
      if (kind === 'cancel') return cancelRun(run!.id)
      if (retryKey.current.runId !== run!.id)
        retryKey.current = { runId: run!.id, key: crypto.randomUUID() }
      return retryTask(taskId, retryKey.current.key)
    },
    onSuccess: () => {
      setError('')
      void refresh()
    },
    onError: (e) => {
      setError(workError(e))
      void refresh()
    },
  })
  return (
    <section className="work-materials" aria-label={templates[view].title}>
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">日常办公</p>
          <h1>{templates[view].title}</h1>
          <p>选择材料、说明目标，生成可核对和编辑的成果。</p>
        </div>
      </header>
      {capabilities.isError && (
        <p role="alert">
          配置加载失败。
          <button onClick={() => void capabilities.refetch()}>重试</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="work-columns">
        <aside className="work-list">
          <button
            className="work-button"
            onClick={() => {
              setError('')
              open()
            }}
          >
            新建工作
          </button>
          <h2>最近工作</h2>
          {tasks.isPending && <p role="status">正在加载工作…</p>}
          {tasks.isError && (
            <p role="alert">
              工作加载失败。
              <button onClick={() => void tasks.refetch()}>重试</button>
            </p>
          )}
          {!tasks.isError &&
            tasks.data?.results.map((t) => (
              <button
                className="work-material-row"
                key={t.id}
                aria-pressed={t.id === taskId}
                onClick={() => {
                  setError('')
                  open(t.id)
                }}
              >
                <span>
                  <strong>{t.goal}</strong>
                  <small>
                    {t.runs.at(-1) && states[t.runs.at(-1)!.status]}
                  </small>
                </span>
              </button>
            ))}
          {tasks.data?.results.length === 0 && (
            <p>还没有工作。先选择材料并填写目标。</p>
          )}
          <nav className="work-pagination" aria-label="工作分页">
            <button
              disabled={!tasks.data?.previous}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <span>{page}</span>
            <button
              disabled={!tasks.data?.next}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </nav>
        </aside>
        <main className="work-detail">
          {!taskId && (
            <form
              className="work-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (selected.length && enabled && !submit.isPending) {
                  setError('')
                  submit.mutate()
                }
              }}
            >
              {!enabled && (
                <p role="status">工作生成尚未启用。可以先上传并核对材料。</p>
              )}
              <fieldset disabled={submit.isPending}>
                <legend>选择材料（{selected.length} / 10）</legend>
                <p>
                  读取选定材料的完整文本，总计不超过 400
                  KB。文件会上传至模型服务处理。
                </p>
                {materials.isError && (
                  <p role="alert">
                    材料加载失败。
                    <button
                      type="button"
                      onClick={() => void materials.refetch()}
                    >
                      重试
                    </button>
                  </p>
                )}
                {!materials.isError &&
                  materials.data?.results.map((item) => (
                    <label className="work-check" key={item.id}>
                      <input
                        type="checkbox"
                        checked={selected.some((m) => m.id === item.id)}
                        disabled={
                          item.status !== 'ready' ||
                          (selected.length >= 10 &&
                            !selected.some((m) => m.id === item.id))
                        }
                        onChange={() =>
                          setSelected((old) =>
                            old.some((m) => m.id === item.id)
                              ? old.filter((m) => m.id !== item.id)
                              : [...old, item]
                          )
                        }
                      />
                      {item.original_name}
                      {item.status !== 'ready' && '（尚未就绪）'}
                    </label>
                  ))}
                <nav className="work-pagination" aria-label="材料分页">
                  <button
                    type="button"
                    disabled={!materials.data?.previous}
                    onClick={() => setMaterialPage(materialPage - 1)}
                  >
                    上一页
                  </button>
                  <span>{materialPage}</span>
                  <button
                    type="button"
                    disabled={!materials.data?.next}
                    onClick={() => setMaterialPage(materialPage + 1)}
                  >
                    下一页
                  </button>
                </nav>
                {selected.map((item) => (
                  <p key={item.id}>
                    {item.original_name}{' '}
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((old) =>
                          old.filter((m) => m.id !== item.id)
                        )
                      }
                    >
                      移除
                    </button>
                  </p>
                ))}
              </fieldset>
              <label>
                工作目标
                <textarea
                  required
                  maxLength={2000}
                  value={goal}
                  disabled={submit.isPending}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </label>
              <label>
                补充背景（可选）
                <textarea
                  maxLength={4000}
                  value={background}
                  disabled={submit.isPending}
                  onChange={(e) => setBackground(e.target.value)}
                />
              </label>
              <p className="work-muted">
                使用 {capabilities.data?.agent_model || '已配置模型'}
                。成果需核实后使用。
              </p>
              <button
                className="work-button work-primary"
                disabled={
                  !enabled ||
                  !selected.length ||
                  !goal.trim() ||
                  submit.isPending
                }
              >
                {submit.isPending ? '正在提交…' : '开始处理'}
              </button>
            </form>
          )}
          {taskId && task.isPending && <p role="status">正在恢复工作…</p>}
          {taskId && task.isError && (
            <p role="alert">
              {workError(task.error)}
              <button onClick={() => void task.refetch()}>重试</button>
            </p>
          )}
          {taskId && task.data && !task.isError && (
            <>
              <h2>{task.data.goal}</h2>
              <p>{task.data.background}</p>
              <p>本次选择 {task.data.sources.length} 份材料</p>
              {run && (
                <>
                  <p role="status">
                    {states[run.status]} · {run.model}
                  </p>
                  {run.execution_target === 'local' && (
                    <p>执行位置：客户端 · {run.workspace_label}</p>
                  )}
                  <p className="work-muted">
                    预留 {run.reserved_tokens} tokens；
                    {run.input_tokens === null
                      ? '实际用量待确认'
                      : `${run.usage_origin === 'device_reported' ? '设备上报' : '实际'}输入 ${run.input_tokens} / 输出 ${run.output_tokens} tokens`}
                    。取消后仍会记录已发生的用量。
                  </p>
                  {run.error_code && (
                    <p role="alert">{workError(run.error_code)}</p>
                  )}
                  <button
                    className="work-button"
                    disabled={
                      command.isPending ||
                      (!cancelable(run) &&
                        (!enabled || run.execution_target === 'local'))
                    }
                    onClick={() =>
                      command.mutate(cancelable(run) ? 'cancel' : 'retry')
                    }
                  >
                    {cancelable(run)
                      ? '取消处理'
                      : run.execution_target === 'local'
                        ? '请在执行设备创建新任务'
                        : '重新生成（新增一次用量）'}
                  </button>
                  {run.execution_target === 'local' &&
                  !run.synced_files?.length ? (
                    <p>成果正文保留在执行设备，可在该设备上选择同步。</p>
                  ) : (
                    <RunArtifacts
                      key={taskId}
                      runs={task.data.runs}
                      ownerId={ownerId}
                    />
                  )}
                  {run.status === 'succeeded' && (
                    <GeneratedFiles
                      key={`files-${run.id}`}
                      runId={run.id}
                      ownerId={ownerId}
                    />
                  )}
                  <RunProgress key={run.id} runId={run.id} ownerId={ownerId} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </section>
  )
}

function GeneratedFiles({
  runId,
  ownerId,
}: {
  runId: string
  ownerId: string
}) {
  const [error, setError] = useState('')
  const files = useQuery({
    queryKey: ['work', ownerId, 'files', runId],
    queryFn: () => listRunFiles(runId),
    retry: false,
  })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const download = useMutation({
    mutationFn: async (name: string) => {
      const blob = await downloadRunFile(runId, name)
      if (!alive.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    onError: (e) => setError(workError(e)),
  })
  return (
    <section className="work-output">
      <h2>原始成果文件</h2>
      <p>保留生成时的原始版本；编辑后的草稿在上方另行保存。</p>
      {(files.isError || error) && (
        <p role="alert">
          {error || workError(files.error)}
          <button onClick={() => void files.refetch()}>重试</button>
        </p>
      )}
      {!files.isError &&
        files.data?.map((file) => (
          <button
            key={file.name}
            className="work-button"
            disabled={download.isPending}
            onClick={() => {
              setError('')
              download.mutate(file.name)
            }}
          >
            {file.name}
          </button>
        ))}
    </section>
  )
}
