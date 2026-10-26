import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  adoptArtifact,
  downloadArtifact,
  getArtifact,
  getRunEvents,
  saveArtifact,
  type Artifact,
  type RunEvent,
  type WorkRun,
} from '../api/tasks'
import { workError } from '../api/work'

const active = (run?: WorkRun) =>
  run?.status === 'queued' || run?.status === 'running'

export function RunProgress({
  runId,
  ownerId,
}: {
  runId: string
  ownerId: string
}) {
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
    succeeded: '成果已保存',
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

export function RunArtifacts({
  runs,
  ownerId,
}: {
  runs: WorkRun[]
  ownerId: string
}) {
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
    <section className="work-output" aria-label="工作成果">
      <h2>成果</h2>
      <label>
        查看生成记录
        <select value={runId} onChange={(e) => setChosen(e.target.value)}>
          {successful.map((run, i) => (
            <option key={run.id} value={run.id}>
              第 {i + 1} 份成功成果
            </option>
          ))}
        </select>
      </label>
      {artifact.isPending && <p role="status">正在读取成果…</p>}
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
        link.download = `工作成果-v${saved.version}.md`
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
          ? '人工编辑，事实仍需重新核对'
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
        <summary>版本历史</summary>
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
      </details>
    </div>
  )
}
