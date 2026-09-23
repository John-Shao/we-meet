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
  adoptArtifact,
  cancelRun,
  createTask,
  downloadArtifact,
  getArtifact,
  getTask,
  getRunEvents,
  listTasks,
  retryTask,
  saveArtifact,
  type Artifact,
  type TaskInput,
  type WorkRun,
  type RunEvent,
} from '../api/tasks'

const active = (run?: WorkRun) =>
  run?.status === 'queued' || run?.status === 'running'
const states: Record<WorkRun['status'], string> = {
  queued: '等待生成',
  running: '正在生成',
  succeeded: '草稿已完成',
  failed: '生成失败',
  canceled: '已取消',
}

export const Communication = ({ ownerId }: { ownerId: string }) => {
  const [params] = useSearchParams()
  const [, navigate] = useLocation()
  const taskId = params.get('task') || ''
  const [page, setPage] = useState(1)
  const client = useQueryClient()
  const root = ['work', ownerId]
  const capabilities = useQuery({
    queryKey: [...root, 'capabilities'],
    queryFn: getWorkCapabilities,
    retry: false,
  })
  const tasks = useQuery({
    queryKey: [...root, 'tasks', page],
    queryFn: () => listTasks(page),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.results.some((t) => t.runs.some(active)) ? 2500 : false,
  })
  const task = useQuery({
    queryKey: [...root, 'task', taskId],
    queryFn: () => getTask(taskId),
    enabled: !!taskId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.runs.some(active) ? 2000 : false),
  })
  const refresh = () => client.invalidateQueries({ queryKey: root })
  const run = task.data?.runs.at(-1)
  const [error, setError] = useState('')
  const retryKey = useRef({ id: '', key: crypto.randomUUID() })
  const command = useMutation({
    mutationFn: (kind: 'cancel' | 'retry') => {
      if (kind === 'cancel') return cancelRun(run!.id)
      if (retryKey.current.id !== run?.id)
        retryKey.current = { id: run!.id, key: crypto.randomUUID() }
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
  const canGenerate = capabilities.data?.communication_enabled === true
  return (
    <section className="work-materials" aria-label="沟通准备">
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">日常办公</p>
          <h1>沟通准备</h1>
          <p>根据选定材料，准备背景、议程、问题和建议话术。</p>
        </div>
        <button className="work-button" onClick={() => navigate('/work')}>
          工作材料
        </button>
      </header>
      <div className="work-columns">
        <aside className="work-list" aria-label="沟通任务">
          <button
            className="work-button work-primary"
            onClick={() => navigate('/work?view=communication')}
          >
            新建沟通准备
          </button>
          <h2>最近任务</h2>
          {tasks.isPending && <p role="status">正在加载任务…</p>}
          {tasks.isError && (
            <p role="alert">
              任务加载失败。
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
                  navigate(`/work?view=communication&task=${t.id}`)
                }}
              >
                <span>
                  <strong>{t.recipient}</strong>
                  <small>{t.goal}</small>
                  <small>
                    {t.runs.at(-1) && states[t.runs.at(-1)!.status]}
                  </small>
                </span>
              </button>
            ))}
          {tasks.data?.results.length === 0 && (
            <p>还没有任务。先选择材料并填写沟通目标。</p>
          )}
          <nav className="work-pagination" aria-label="任务分页">
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
            <CommunicationForm
              key={ownerId}
              ownerId={ownerId}
              enabled={canGenerate}
              model={capabilities.data?.model || ''}
              onCreated={(id) => {
                void refresh()
                navigate(`/work?view=communication&task=${id}`)
              }}
            />
          )}
          {taskId && task.isPending && <p role="status">正在恢复任务…</p>}
          {taskId && task.isError && (
            <p role="alert">
              任务不存在或当前账号无权访问。
              <button onClick={() => void task.refetch()}>重试</button>
            </p>
          )}
          {taskId && task.data && !task.isError && (
            <>
              <h2>与 {task.data.recipient} 沟通</h2>
              <p>{task.data.goal}</p>
              {task.data.background && (
                <p className="work-muted">
                  补充背景（用户提供）：{task.data.background}
                </p>
              )}
              <p>本次选择 {task.data.sources.length} 份材料 · 仅自己可见</p>
              {run && (
                <>
                  <p role="status">
                    {states[run.status]} · {run.model}
                  </p>
                  <p className="work-muted">
                    本次预占 {run.reserved_tokens} tokens；
                    {run.input_tokens === null
                      ? '实际用量待确认'
                      : `实际输入 ${run.input_tokens} / 输出 ${run.output_tokens} tokens`}
                    。取消可能仍产生已发起调用的用量。
                  </p>
                  {run.error_code && (
                    <p role="alert">{workError(run.error_code)}</p>
                  )}
                  {error && <p role="alert">{error}</p>}
                  {active(run) ? (
                    <button
                      className="work-button"
                      disabled={command.isPending}
                      onClick={() => command.mutate('cancel')}
                    >
                      取消生成
                    </button>
                  ) : (
                    <button
                      className="work-button"
                      disabled={!canGenerate || command.isPending}
                      onClick={() => command.mutate('retry')}
                    >
                      重新生成（新增一次用量）
                    </button>
                  )}
                  <RunArtifacts
                    key={taskId}
                    runs={task.data.runs}
                    ownerId={ownerId}
                  />
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

function CommunicationForm({
  ownerId,
  enabled,
  model,
  onCreated,
}: {
  ownerId: string
  enabled: boolean
  model: string
  onCreated: (id: string) => void
}) {
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Material[]>([])
  const [recipient, setRecipient] = useState('')
  const [goal, setGoal] = useState('')
  const [background, setBackground] = useState('')
  const [error, setError] = useState('')
  const key = useRef({ input: '', key: '' })
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const materials = useQuery({
    queryKey: ['work', ownerId, 'materials', page],
    queryFn: () => listMaterials(page),
    retry: false,
  })
  const submit = useMutation({
    mutationFn: async (data: TaskInput) => {
      const input = JSON.stringify(data)
      if (key.current.input !== input)
        key.current = { input, key: crypto.randomUUID() }
      const abort = new AbortController()
      controller.current = abort
      const result = await createTask(data, key.current.key, abort.signal)
      if (!abort.signal.aborted) onCreated(result.id)
    },
    onError: (e) => {
      if (!controller.current?.signal.aborted) setError(workError(e))
    },
  })
  const toggle = (item: Material) =>
    setSelected((current) =>
      current.some((m) => m.id === item.id)
        ? current.filter((m) => m.id !== item.id)
        : [...current, item]
    )
  return (
    <form
      className="work-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!selected.length || submit.isPending) return
        setError('')
        submit.mutate({
          recipient,
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
        })
      }}
    >
      <h2>准备一次沟通</h2>
      {!enabled && (
        <p role="status">沟通生成尚未启用或模型未配置，可先上传和核对材料。</p>
      )}
      <fieldset disabled={submit.isPending}>
        <legend>选择材料（{selected.length} / 10）</legend>
        <p className="work-muted">
          只读取选中的完整文本，总计不超过 12,000 字符；超出时会提示缩小范围。
        </p>
        {materials.isError && (
          <p role="alert">
            材料加载失败。
            <button type="button" onClick={() => void materials.refetch()}>
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
                onChange={() => toggle(item)}
              />
              <span>
                {item.original_name} ·{' '}
                {item.status === 'ready' ? `${item.line_count} 行` : '尚未就绪'}
              </span>
            </label>
          ))}
        <nav className="work-pagination" aria-label="选择材料分页">
          <button
            type="button"
            disabled={!materials.data?.previous}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span>{page}</span>
          <button
            type="button"
            disabled={!materials.data?.next}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </nav>
        {!!selected.length && (
          <div aria-label="已选材料">
            {selected.map((item) => (
              <p key={item.id}>
                {item.original_name}{' '}
                <button type="button" onClick={() => toggle(item)}>
                  移除
                </button>
              </p>
            ))}
          </div>
        )}
      </fieldset>
      <label>
        沟通对象
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          maxLength={200}
          required
          disabled={submit.isPending}
          placeholder="例如：客户项目负责人"
        />
      </label>
      <label>
        沟通目标
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={2000}
          required
          disabled={submit.isPending}
          placeholder="希望澄清或推进哪些事情？"
        />
      </label>
      <label>
        补充背景（可选）
        <textarea
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          maxLength={4000}
          disabled={submit.isPending}
          placeholder="时间、关注点和已有安排；这些信息会标记为用户提供。"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <p className="work-muted">
        {model && `使用 ${model}；`}生成可编辑草稿，不会自动发送或安排会议。
      </p>
      <button
        className="work-button work-primary"
        disabled={!enabled || !selected.length || submit.isPending}
      >
        {submit.isPending ? '正在提交…' : '生成沟通草稿'}
      </button>
    </form>
  )
}

function RunProgress({ runId, ownerId }: { runId: string; ownerId: string }) {
  const cursor = useRef(0)
  const seen = useRef<RunEvent[]>([])
  const progress = useQuery({
    // Cursor and accumulated events are transport state for this run, not resource identity.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: ['work', ownerId, 'events', runId],
    queryFn: async () => {
      const result = await getRunEvents(runId, cursor.current)
      const unique = new Map(
        [...seen.current, ...result.events].map((event) => [event.seq, event])
      )
      seen.current = [...unique.values()].sort((a, b) => a.seq - b.seq)
      cursor.current = result.next_after
      return { ...result, events: seen.current }
    },
    retry: false,
    refetchInterval: (q) => (active(q.state.data?.run) ? 2000 : false),
  })
  const labels: Record<string, string> = {
    queued: '任务已受理',
    running: '已开始处理',
    model_started: '已提交模型生成',
    succeeded: '草稿已保存',
    failed: '执行失败',
    canceled: '已取消',
    artifact_adopted: '版本已采纳',
  }
  return (
    <details className="work-output">
      <summary>执行记录</summary>
      {progress.isError && (
        <p role="alert">
          进度暂时不可用。
          <button onClick={() => void progress.refetch()}>重试</button>
        </p>
      )}
      {!progress.isError &&
        progress.data?.events.map((event) => (
          <p key={event.seq}>
            {event.seq}. {labels[event.type] || '状态已更新'}
          </p>
        ))}
    </details>
  )
}

function RunArtifacts({ runs, ownerId }: { runs: WorkRun[]; ownerId: string }) {
  const successful = runs.filter((run) => run.status === 'succeeded')
  const [chosen, setChosen] = useState('')
  const runId = chosen || successful.at(-1)?.id || ''
  const artifact = useQuery({
    queryKey: ['work', ownerId, 'artifact', runId],
    queryFn: () => getArtifact(runId),
    enabled: !!runId,
    retry: false,
  })
  if (!runId) return null
  return (
    <section className="work-output" aria-label="沟通草稿">
      <h2>成果</h2>
      <label>
        查看生成记录
        <select value={runId} onChange={(e) => setChosen(e.target.value)}>
          {successful.map((run, i) => (
            <option key={run.id} value={run.id}>
              第 {i + 1} 份成功草稿
            </option>
          ))}
        </select>
      </label>
      {artifact.isPending && <p role="status">正在读取草稿…</p>}
      {artifact.isError && (
        <p role="alert">
          {workError(artifact.error)}
          <button onClick={() => void artifact.refetch()}>重试</button>
        </p>
      )}
      {artifact.data && !artifact.isError && (
        <ArtifactEditor key={runId} runId={runId} initial={artifact.data} />
      )}
    </section>
  )
}

function ArtifactEditor({
  runId,
  initial,
}: {
  runId: string
  initial: Artifact
}) {
  const [saved, setSaved] = useState(initial)
  const [body, setBody] = useState(initial.body)
  const [message, setMessage] = useState('')
  const [past, setPast] = useState<Artifact | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const dirty = body !== saved.body
  const action = useMutation({
    mutationFn: async (kind: 'save' | 'adopt' | 'download' | 'reload') => {
      setMessage('')
      if (kind === 'download') {
        const blob = await downloadArtifact(runId, saved.version)
        if (!alive.current) return
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `沟通准备-v${saved.version}.md`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        return
      }
      const result =
        kind === 'save'
          ? await saveArtifact(runId, saved.version, body)
          : kind === 'adopt'
            ? await adoptArtifact(runId, saved.version)
            : await getArtifact(runId)
      if (!alive.current) return
      setSaved(result)
      if (kind === 'reload') {
        setPast(result)
        setMessage(
          '已读取最新版本；你的未保存文本仍保留在编辑框中，可比较后再保存。'
        )
      } else {
        setBody(result.body)
        setPast(null)
        setMessage(
          kind === 'adopt'
            ? '已采纳此版本，仅保存在当前任务。'
            : '已保存新版本。'
        )
      }
    },
    onError: (e) => setMessage(workError(e)),
  })
  const history = useMutation({
    mutationFn: (version: number) => getArtifact(runId, version),
    onSuccess: setPast,
    onError: (e) => setMessage(workError(e)),
  })
  return (
    <div className="work-form">
      <p>
        当前版本 v{saved.version} · {saved.adopted_at ? '已采纳' : '未采纳'} ·{' '}
        {saved.origin === 'edited'
          ? '人工编辑，引用可能需要重新核对'
          : 'AI 草稿，事实含义仍需核实'}
      </p>
      <label>
        编辑草稿
        <textarea
          className="work-editor"
          aria-label="编辑草稿"
          value={body}
          maxLength={40000}
          onChange={(e) => setBody(e.target.value)}
          disabled={action.isPending}
        />
      </label>
      <div className="work-actions">
        <button
          className="work-button work-primary"
          disabled={!dirty || action.isPending}
          onClick={() => action.mutate('save')}
        >
          保存新版本
        </button>
        <button
          className="work-button"
          disabled={dirty || action.isPending || !!saved.adopted_at}
          onClick={() => action.mutate('adopt')}
        >
          采纳此版本
        </button>
        <button
          className="work-button"
          disabled={dirty || action.isPending}
          onClick={() => action.mutate('download')}
        >
          下载 Markdown
        </button>
        <button
          className="work-button"
          disabled={action.isPending}
          onClick={() => action.mutate('reload')}
        >
          读取最新版本
        </button>
      </div>
      {dirty && (
        <p role="status">
          有未保存修改。离开页面前请保存；采纳和下载使用已保存版本。
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <details>
        <summary>版本历史与引用原文</summary>
        <div className="work-actions">
          {Array.from({ length: saved.version }, (_, i) => (
            <button
              key={i}
              disabled={history.isPending}
              onClick={() => history.mutate(i + 1)}
            >
              v{i + 1}
            </button>
          ))}
        </div>
        {past && <pre className="work-history">{past.body}</pre>}
        <p className="work-muted">
          以下为首次生成时校验的引用，人工修改不会自动重新校验。
        </p>
        {saved.citations.map((cite, i) => (
          <p key={i}>
            〔来源 {i + 1}〕
            <a href={`/work?material=${cite.source_id}&line=${cite.line}`}>
              {cite.name}
            </a>{' '}
            · {cite.location}
            <br />
            {cite.quote}
          </p>
        ))}
      </details>
    </div>
  )
}
