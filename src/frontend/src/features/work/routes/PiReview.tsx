import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { workError } from '../api/materials'
import { cancelReview, createReview, listReviews } from '../api/reviews'
import { listRunFiles } from '../api/tasks'

const states = {
  queued: '等待复核',
  running: '正在复核',
  succeeded: '复核完成',
  failed: '复核失败',
  canceled: '已取消复核',
}
const verdicts = {
  no_issues: '在提供的材料中未发现问题',
  needs_changes: '发现需要处理的问题',
  inconclusive: '信息不足，仍需确认',
}

export function PiReview({
  ownerId,
  runId,
  enabled,
  tokenBudget,
}: {
  ownerId: string
  runId: string
  enabled: boolean
  tokenBudget?: number
}) {
  const client = useQueryClient()
  const root = ['work', ownerId, 'reviews', runId]
  const [selected, setSelected] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const key = useRef({ input: '', key: '' })
  const files = useQuery({
    queryKey: ['work', ownerId, 'files', runId],
    queryFn: () => listRunFiles(runId),
    retry: false,
  })
  const reviews = useQuery({
    queryKey: root,
    queryFn: () => listReviews(runId),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'queued' || r.status === 'running')
        ? 2000
        : false,
  })
  // A failed permission recheck must not leave previously cached material visible.
  const unavailable = files.isError || reviews.isError
  useEffect(() => {
    if (unavailable) {
      setSelected([])
      setConsent(false)
      key.current = { input: '', key: '' }
    }
  }, [unavailable])
  const visibleFiles = unavailable ? [] : files.data
  const visibleReviews = unavailable ? [] : reviews.data
  const active = visibleReviews?.find(
    (r) => r.status === 'queued' || r.status === 'running'
  )
  const command = useMutation({
    mutationFn: async (action: 'create' | 'cancel') => {
      if (action === 'cancel') return cancelReview(runId, active!.id)
      const selection = (files.data || [])
        .filter((file) => selected.includes(file.name))
        .sort((a, b) => a.name.localeCompare(b.name))
      const input = JSON.stringify(selection)
      if (key.current.input !== input)
        key.current = { input, key: crypto.randomUUID() }
      return createReview(runId, selection, key.current.key)
    },
    onSuccess: () => {
      key.current = { input: '', key: '' }
      setError('')
      void client.invalidateQueries({ queryKey: root })
    },
    onError: (e) => setError(workError(e)),
  })
  return (
    <section className="work-output" aria-label="成果复核">
      <h2>成果复核</h2>
      <p>
        只检查选定成果与本任务材料，不修改文件或执行命令。复核意见需要核实。
      </p>
      {(error || files.isError || reviews.isError) && (
        <p role="alert">
          {error || workError(files.error || reviews.error)}
          <button
            onClick={() => {
              void files.refetch()
              void reviews.refetch()
            }}
          >
            重新加载
          </button>
        </p>
      )}
      {enabled && (
        <fieldset disabled={command.isPending || !!active || unavailable}>
          <legend>选择复核文件（最多 8 个）</legend>
          {visibleFiles?.map((file) => (
            <label className="work-check" key={file.name}>
              <input
                type="checkbox"
                checked={selected.includes(file.name)}
                disabled={selected.length >= 8 && !selected.includes(file.name)}
                onChange={() =>
                  setSelected((old) =>
                    old.includes(file.name)
                      ? old.filter((name) => name !== file.name)
                      : [...old, file.name]
                  )
                }
              />
              {file.name}
            </label>
          ))}
          {!files.isPending && !files.isError && !files.data?.length && (
            <p>暂无可复核文件。桌面成果需先在执行设备上选择同步。</p>
          )}
          <label className="work-check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            同意将选定成果和本任务已授权材料发送至复核模型
          </label>
          <p>本次额外预留 {tokenBudget || 20000} tokens。</p>
          <button
            className="work-button"
            disabled={
              !consent ||
              !selected.length ||
              files.isError ||
              reviews.isPending ||
              reviews.isError
            }
            onClick={() => command.mutate('create')}
          >
            开启本次复核
          </button>
        </fieldset>
      )}
      {!enabled && <p>复核服务尚未启用，已有记录仍可查看。</p>}
      {active && (
        <button
          disabled={command.isPending}
          onClick={() => command.mutate('cancel')}
        >
          取消复核
        </button>
      )}
      {visibleReviews?.map((review) => (
        <article key={review.id}>
          <h3>{states[review.status]}</h3>
          <p>
            {review.model} · {review.selection.map((f) => f.name).join('、')}
          </p>
          <p>
            {review.input_tokens === null
              ? `预留 ${review.reserved_tokens} tokens，实际用量待确认`
              : `实际输入 ${review.input_tokens} / 输出 ${review.output_tokens} tokens`}
          </p>
          {review.error_code && (
            <p role="alert">{workError(review.error_code)}</p>
          )}
          {review.report.verdict && (
            <>
              <h4>
                {
                  verdicts[
                    review.report.missing_information?.length
                      ? 'inconclusive'
                      : review.report.verdict
                  ]
                }
              </h4>
              {!!review.report.missing_information?.length && (
                <p>材料不完整，复核意见仍需核实，不能据此确认任务结果错误。</p>
              )}
              <p>{review.report.summary}</p>
              {review.report.findings?.map((finding, index) => (
                <div key={index}>
                  <p>
                    {finding.severity === 'error' ? '问题' : '提醒'}：
                    {finding.message}
                  </p>
                  {finding.evidence.map((evidence, ref) => (
                    <blockquote key={ref}>
                      <p>{evidence.quote}</p>
                      <small>
                        {evidence.file} · SHA-256 {evidence.sha256}
                      </small>
                    </blockquote>
                  ))}
                </div>
              ))}
              {!!review.report.missing_information?.length && (
                <ul>
                  {review.report.missing_information.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  )
}
