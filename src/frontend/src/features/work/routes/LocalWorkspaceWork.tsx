import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useLocation } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { localError, type LocalJob, type LocalWorkspace } from '../api/local'
import {
  getWorkCapabilities,
  listMaterials,
  type Material,
} from '../api/materials'
import { PiReview } from './PiReview'

const active = (job?: LocalJob) =>
  job?.state === 'queued' || job?.state === 'running'
const states = {
  queued: '等待处理',
  running: '正在本机处理',
  succeeded: '成果已完成',
  failed: '处理失败',
  cancelled: '已取消',
  needs_confirmation: '等待确认原任务',
}
const goals: Record<string, string> = {
  new: '',
  weekly:
    '阅读工作空间中与本周进展有关的材料，整理进展、风险和下周计划，生成 report.md。保留未确认和待验收状态，列出缺失信息。',
  spreadsheet:
    '分析工作空间中的相关表格文件，说明清洗和统计口径，生成 report.md 及可复核的 CSV 或 JSON 结果。保留原始文件。',
}

export function LocalWorkspaceWork({
  ownerId,
  view,
}: {
  ownerId: string
  view: string
}) {
  const bridge = window.weMeetDesktop!.localWork!
  const [params] = useSearchParams()
  const [, navigate] = useLocation()
  const selected = params.get('localRun') || ''
  const client = useQueryClient()
  const root = ['work-local', ownerId]
  const [workspace, setWorkspace] = useState<LocalWorkspace | null>(null)
  const [goal, setGoal] = useState(goals[view] || '')
  const [model, setModel] = useState('deepseek-flash')
  const [error, setError] = useState('')
  const [tracking, setTracking] = useState(false)
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialPage, setMaterialPage] = useState(1)
  const [shared, setShared] = useState<string[]>([])
  const [remoteAllowed, setRemoteAllowed] = useState(false)
  const submission = useRef({ signature: '', id: '' })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const capabilities = useQuery({
    queryKey: [...root, 'capabilities'],
    queryFn: () => bridge.status(),
    retry: false,
  })
  const ready = capabilities.data?.ready === true
  const coordinationEnabled = capabilities.data?.coordination_enabled === true
  const cloudCapabilities = useQuery({
    queryKey: ['work', ownerId, 'capabilities'],
    queryFn: getWorkCapabilities,
    enabled: coordinationEnabled,
    retry: false,
  })
  const remoteInbox = useQuery({
    queryKey: [...root, 'remote-inbox'],
    queryFn: () => bridge.remoteInbox(),
    enabled: ready && capabilities.data?.remote_enabled === true,
    retry: false,
    refetchInterval: 10000,
  })
  const remoteRegistration = useMutation({
    mutationFn: (enabled: boolean) =>
      bridge.registerRemoteWorkspace(workspace!.id, enabled),
    onSuccess: (_value, enabled) => {
      if (alive.current) {
        setRemoteAllowed(enabled)
        void refresh()
      }
    },
    onError: (e) => {
      if (alive.current) setError(localError(e))
    },
  })
  const takeRemote = useMutation({
    mutationFn: (id: string) => bridge.takeRemote(id, workspace!.id),
    onSuccess: (value) => {
      if (alive.current && value) {
        open(value.run_id)
        void refresh()
      }
    },
    onError: (e) => {
      if (alive.current) setError(localError(e))
    },
  })
  useEffect(() => {
    if (capabilities.data?.coordination_enabled) setTracking(true)
  }, [capabilities.data?.coordination_enabled])
  const cloudMaterials = useQuery({
    queryKey: [...root, 'cloud-materials', materialPage],
    queryFn: () => listMaterials(materialPage),
    enabled: coordinationEnabled && tracking && !selected,
    retry: false,
  })
  const history = useQuery({
    queryKey: [...root, 'jobs'],
    queryFn: () => bridge.list(),
    enabled: ready,
    retry: false,
    refetchInterval: (q) => (q.state.data?.some(active) ? 1500 : false),
  })
  const job = useQuery({
    queryKey: [...root, 'job', selected],
    queryFn: () => bridge.get(selected),
    enabled: ready && !!selected,
    retry: false,
    refetchInterval: (q) =>
      active(q.state.data) ||
      (q.state.data?.coordination &&
        !q.state.data.coordination.synced &&
        q.state.data.state !== 'needs_confirmation')
        ? 1500
        : false,
  })
  const refresh = () => client.invalidateQueries({ queryKey: root })
  const open = (id = '') =>
    navigate(`/work?view=${view}${id ? `&localRun=${id}` : ''}`)
  const operation = useMutation({
    mutationFn: async (
      kind:
        | 'configure'
        | 'workspace'
        | 'submit'
        | 'cancel'
        | 'resume'
        | 'sync'
        | 'update'
        | 'rollback'
    ) => {
      setError('')
      if (kind === 'update' || kind === 'rollback') {
        await (kind === 'update'
          ? bridge.updateRuntime()
          : bridge.rollbackRuntime())
        if (alive.current) {
          setWorkspace(null)
          void refresh()
        }
      }
      if (kind === 'configure') {
        await bridge.configure(model)
        if (alive.current) {
          setWorkspace(null)
          void refresh()
        }
      }
      if (kind === 'workspace') {
        const grant = await bridge.pickWorkspace()
        if (alive.current && grant) {
          setWorkspace(grant)
          setRemoteAllowed(false)
        }
      }
      if (kind === 'submit') {
        const sources = tracking
          ? materials.map(({ id, checksum, parser_version, generation }) => ({
              id,
              checksum,
              parser_version,
              generation,
            }))
          : []
        const signature = JSON.stringify({
          workspace_id: workspace!.id,
          goal,
          tracking,
          sources,
        })
        if (submission.current.signature !== signature)
          submission.current = { signature, id: crypto.randomUUID() }
        const result = await bridge.submit({
          run_id: submission.current.id,
          workspace_id: workspace!.id,
          goal,
          track_cloud: tracking,
          sources,
        })
        if (alive.current) {
          open(result.run_id)
          void refresh()
        }
      }
      if (kind === 'cancel') {
        await bridge.cancel(selected)
        if (alive.current) void refresh()
      }
      if (kind === 'resume') {
        await bridge.resume(selected, workspace!.id)
        if (alive.current) void refresh()
      }
      if (kind === 'sync') {
        try {
          await bridge.syncFiles(selected, shared)
        } finally {
          if (alive.current) {
            void client.invalidateQueries({
              queryKey: ['work', ownerId, 'files', selected],
            })
            void refresh()
          }
        }
      }
    },
    onError: (e) => {
      if (alive.current) {
        setError(localError(e))
        void refresh()
      }
    },
  })
  const fileOpen = useMutation({
    mutationFn: (name: string) => bridge.openArtifact(selected, name),
    onError: (e) => setError(localError(e)),
  })
  const [chosenFile, setChosenFile] = useState('')
  useEffect(() => {
    setShared([])
    setChosenFile('')
  }, [selected])
  const approvalReview = useMutation({
    mutationFn: (approval: { id: string; sha256: string }) =>
      bridge.reviewApproval(selected, approval.id, approval.sha256),
    onSuccess: () => {
      if (alive.current) void refresh()
    },
    onError: (e) => {
      if (alive.current) setError(localError(e))
    },
  })
  const artifacts = job.data?.result?.artifacts || []
  const artifact =
    artifacts.find((item) => item.name === chosenFile) || artifacts[0]
  return (
    <section
      className="work-materials work-local-workspace"
      aria-label="本地工作空间"
    >
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">本机执行</p>
          <h1>本地工作空间</h1>
          <p>选择电脑上的文件夹，由本机 dsh 读取材料并生成成果。</p>
        </div>
        <button
          className="work-button"
          onClick={() => navigate(`/work?view=${view}&execution=cloud`)}
        >
          使用云端材料
        </button>
      </header>
      {(error || capabilities.isError) && (
        <p role="alert">
          {error || localError(capabilities.error)}
          <button onClick={() => void refresh()}>刷新查询</button>
        </p>
      )}
      <details className="work-output" open={!ready}>
        <summary>本机执行器配置</summary>
        <p>
          {capabilities.data?.bundled_runtime
            ? '已内置本机执行器，只需选择模型密钥文件。'
            : '选择本地执行器及模型密钥文件。'}
          密钥保存在桌面安全存储中。
        </p>
        <label>
          模型
          <input
            value={model}
            maxLength={80}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <button
          className="work-button"
          disabled={operation.isPending}
          onClick={() => operation.mutate('configure')}
        >
          {ready ? '更新本机配置' : '配置本机 dsh'}
        </button>
        {capabilities.data?.runtime && (
          <div>
            <p>执行器版本 {capabilities.data.runtime.version}</p>
            <button
              className="work-button"
              disabled={
                operation.isPending ||
                !capabilities.data.runtime.signed_updates_enabled
              }
              onClick={() => operation.mutate('update')}
            >
              安装签名升级包
            </button>
            <button
              className="work-button"
              disabled={
                operation.isPending || !capabilities.data.runtime.previous
              }
              onClick={() => operation.mutate('rollback')}
            >
              回退上一版本
            </button>
            {!capabilities.data.runtime.signed_updates_enabled && (
              <p>内部测试版本；正式升级签名尚未配置。</p>
            )}
          </div>
        )}
      </details>
      {ready && (
        <p>
          已连接 dsh {capabilities.data?.runtime_version} ·{' '}
          {capabilities.data?.model}
        </p>
      )}
      <div className="work-columns">
        <aside className="work-list">
          <button
            className="work-button"
            onClick={() => {
              submission.current = { signature: '', id: '' }
              setError('')
              open()
            }}
          >
            新建本地工作
          </button>
          <h2>本机任务</h2>
          {capabilities.data?.remote_enabled && (
            <section>
              <h2>远程待办</h2>
              {remoteInbox.isError && (
                <p role="alert">{localError(remoteInbox.error)}</p>
              )}
              {(remoteInbox.data || []).map((item) => (
                <div key={item.run_id}>
                  <p>{item.goal}</p>
                  <small>{item.workspace_label}</small>
                  <button
                    className="work-button"
                    disabled={
                      !workspace ||
                      workspace.id !== item.workspace_id ||
                      !remoteAllowed ||
                      takeRemote.isPending
                    }
                    onClick={() => takeRemote.mutate(item.run_id)}
                  >
                    审阅并领取
                  </button>
                </div>
              ))}
              {!remoteInbox.data?.length && (
                <p>授权工作空间后显示可领取的远程请求。</p>
              )}
            </section>
          )}
          {history.isError && <p role="alert">{localError(history.error)}</p>}
          {history.data?.map((item) => (
            <button
              className="work-material-row"
              key={item.run_id}
              aria-pressed={item.run_id === selected}
              onClick={() => {
                setChosenFile('')
                setError('')
                open(item.run_id)
                setShared([])
              }}
            >
              <span>
                <strong>{item.goal}</strong>
                <small>
                  {states[item.state]} · {item.workspace}
                </small>
              </span>
            </button>
          ))}
          {ready && history.data?.length === 0 && <p>还没有本地任务。</p>}
        </aside>
        <main className="work-detail">
          <button
            className="work-button"
            disabled={!ready || operation.isPending}
            onClick={() => operation.mutate('workspace')}
          >
            {workspace ? '更换或重新授权文件夹' : '选择本地文件夹'}
          </button>
          {workspace && <p>当前工作空间：{workspace.path}</p>}
          {workspace && capabilities.data?.remote_enabled && (
            <label>
              <input
                type="checkbox"
                checked={remoteAllowed}
                disabled={remoteRegistration.isPending}
                onChange={(e) => remoteRegistration.mutate(e.target.checked)}
              />
              允许远程请求进入此工作空间待办
              <p className="work-muted">
                手机提交的请求先进入待办；重新登录后需要重新授权目录才能领取。具体命令仍需逐次批准。
              </p>
            </label>
          )}
          <p className="work-muted">
            文件保留在本机；提供给模型的内容仍会通过 API
            发送。工作空间不是操作系统沙箱。重新登录或执行器重启后，需要重新授权目录。
          </p>
          {!selected && (
            <form
              className="work-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (workspace && ready && goal.trim() && !operation.isPending)
                  operation.mutate('submit')
              }}
            >
              <label>
                <input
                  type="checkbox"
                  checked={tracking}
                  disabled={!coordinationEnabled || operation.isPending}
                  onChange={(e) => setTracking(e.target.checked)}
                />
                登记到云端任务记录
              </label>
              <p className="work-muted">
                {coordinationEnabled
                  ? '登记目标、文件夹名称、进度和设备上报用量；本地成果正文由你选择后同步。'
                  : '服务端登记暂不可用，本次仅在本机执行。'}
              </p>
              {tracking && (
                <fieldset>
                  <legend>可选云端材料</legend>
                  {cloudMaterials.isError && (
                    <p role="alert">云端材料暂不可用，可不选择材料继续。</p>
                  )}
                  {cloudMaterials.data?.results.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        disabled={
                          item.status !== 'ready' ||
                          operation.isPending ||
                          (!materials.some((m) => m.id === item.id) &&
                            materials.length >= 10)
                        }
                        checked={materials.some((m) => m.id === item.id)}
                        onChange={(e) =>
                          setMaterials((current) =>
                            e.target.checked
                              ? [...current, item]
                              : current.filter((m) => m.id !== item.id)
                          )
                        }
                      />
                      {item.original_name}
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={materialPage <= 1}
                    onClick={() => setMaterialPage((p) => p - 1)}
                  >
                    上一页材料
                  </button>
                  <button
                    type="button"
                    disabled={!cloudMaterials.data?.next}
                    onClick={() => setMaterialPage((p) => p + 1)}
                  >
                    下一页材料
                  </button>
                  <p>
                    已选择 {materials.length}{' '}
                    份云端材料，仅将授权快照提供给本机执行器。
                  </p>
                </fieldset>
              )}
              <label>
                工作目标
                <textarea
                  required
                  maxLength={tracking ? 2000 : 8000}
                  value={goal}
                  disabled={operation.isPending}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </label>
              <p>
                成果保存到所选文件夹内的 WeMeet成果
                目录。仅本机模式保留本地历史；登记模式同时回报云端任务状态。
              </p>
              <button
                className="work-button work-primary"
                disabled={
                  !ready || !workspace || !goal.trim() || operation.isPending
                }
              >
                开始本地处理
              </button>
            </form>
          )}
          {selected && job.isError && (
            <p role="alert">
              {localError(job.error)}
              <button onClick={() => void job.refetch()}>查询原任务</button>
            </p>
          )}
          {selected && job.data && !job.isError && (
            <>
              <h2>{job.data.goal}</h2>
              <p>{job.data.workspace}</p>
              <p role="status">{states[job.data.state]}</p>
              {job.data.coordination && (
                <p>
                  {job.data.coordination.synced
                    ? '任务状态已回报云端'
                    : '任务状态待同步云端'}
                  {job.data.coordination.status === 'canceled' &&
                    '；云端已取消'}
                  {job.data.coordination.status === 'disconnected' &&
                    '；设备断线待确认'}
                  {job.data.coordination.task_id && (
                    <button
                      className="work-button"
                      onClick={() =>
                        navigate(
                          `/work?view=${view}&execution=cloud&task=${job.data!.coordination!.task_id}`
                        )
                      }
                    >
                      查看云端任务记录
                    </button>
                  )}
                </p>
              )}
              {job.data.error_code && (
                <p role="alert">{localError(job.data.error_code)}</p>
              )}
              {!!job.data.approvals?.length && (
                <section className="work-output">
                  <h2>等待操作审批</h2>
                  <p>
                    任务暂停在命令执行前。请核对具体操作；每次批准仅适用于这一条命令。
                  </p>
                  {job.data.approvals.map((approval) => (
                    <div key={approval.id}>
                      <p>{approval.tool}</p>
                      <pre className="work-text">{approval.arguments}</pre>
                      <button
                        className="work-button"
                        disabled={!workspace || approvalReview.isPending}
                        onClick={() => approvalReview.mutate(approval)}
                      >
                        审阅此次操作
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {(active(job.data) ||
                job.data.state === 'needs_confirmation') && (
                <button
                  className="work-button"
                  disabled={operation.isPending}
                  onClick={() => operation.mutate('cancel')}
                >
                  取消本地处理
                </button>
              )}
              {job.data.state === 'needs_confirmation' && (
                <button
                  className="work-button"
                  disabled={!workspace || operation.isPending}
                  onClick={() => operation.mutate('resume')}
                >
                  继续登记原任务
                </button>
              )}
              {job.data.metering && (
                <p>
                  模型调用 {job.data.metering.calls} 次 ·{' '}
                  {job.data.metering.complete
                    ? job.data.metering.usage
                      ? `输入 ${job.data.metering.usage.input_tokens + job.data.metering.usage.cache_read_tokens + job.data.metering.usage.cache_write_tokens} / 输出 ${job.data.metering.usage.output_tokens} tokens`
                      : '尚未发生模型调用'
                    : '用量仍待确认'}
                  。取消仍可能产生已发起调用的用量。
                </p>
              )}
              {job.data.result && (
                <section className="work-output">
                  <h2>本地成果</h2>
                  <p>{job.data.result.summary}</p>
                  <label>
                    查看文件
                    <select
                      value={artifact?.name || ''}
                      onChange={(e) => setChosenFile(e.target.value)}
                    >
                      {artifacts.map((item) => (
                        <option key={item.name}>{item.name}</option>
                      ))}
                    </select>
                  </label>
                  {artifact && (
                    <>
                      <pre className="work-text">{artifact.text}</pre>
                      <button
                        className="work-button"
                        disabled={fileOpen.isPending}
                        onClick={() => fileOpen.mutate(artifact.name)}
                      >
                        在本机打开成果文件
                      </button>
                      {job.data.coordination?.task_id && (
                        <fieldset>
                          <legend>选择要同步到云端的成果</legend>
                          {artifacts.map((item) => (
                            <label key={item.name}>
                              <input
                                type="checkbox"
                                checked={shared.includes(item.name)}
                                disabled={operation.isPending}
                                onChange={(e) =>
                                  setShared((current) =>
                                    e.target.checked
                                      ? [...current, item.name]
                                      : current.filter(
                                          (name) => name !== item.name
                                        )
                                  )
                                }
                              />
                              {item.name}
                              {job.data!.coordination!.uploaded_files.includes(
                                item.name
                              ) && '（已同步）'}
                            </label>
                          ))}
                          <button
                            className="work-button"
                            disabled={!shared.length || operation.isPending}
                            onClick={() => operation.mutate('sync')}
                          >
                            同步所选成果到云端
                          </button>
                        </fieldset>
                      )}
                    </>
                  )}
                </section>
              )}
              {job.data.state === 'succeeded' &&
                job.data.coordination?.status === 'succeeded' &&
                !!job.data.coordination.uploaded_files.length && (
                  <PiReview
                    key={`review-${selected}`}
                    ownerId={ownerId}
                    runId={selected}
                    enabled={cloudCapabilities.data?.review_enabled === true}
                    tokenBudget={cloudCapabilities.data?.review_token_budget}
                  />
                )}
            </>
          )}
        </main>
      </div>
    </section>
  )
}
