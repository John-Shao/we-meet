import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiFileTextLine, RiUploadCloud2Line } from '@remixicon/react'
import { useUser } from '@/features/auth'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import {
  deleteMaterial,
  getMaterial,
  getMaterialPreview,
  getWorkCapabilities,
  listMaterials,
  retryMaterial,
  uploadMaterial,
  workError,
  type Material,
} from '../api/materials'
import './work.css'

const statusLabel: Record<Material['status'], string> = {
  uploaded: '等待解析',
  parsing: '正在解析',
  ready: '可预览',
  failed: '解析失败',
}
const pending = (item?: Material) =>
  item?.status === 'uploaded' || item?.status === 'parsing'
const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

interface UploadItem {
  key: string
  file: File
  error?: string
  done?: boolean
}

export const WorkRoute = () => {
  const { user } = useUser()
  return (
    <RequireAuth>
      <Screen footer={false}>
        <WorkMaterials key={user?.id} ownerId={user?.id || ''} />
      </Screen>
    </RequireAuth>
  )
}

export const WorkMaterials = ({ ownerId }: { ownerId: string }) => {
  const [, navigate] = useLocation()
  const [params] = useSearchParams()
  const selectedId = params.get('material') || ''
  const page = Math.max(1, Number(params.get('page')) || 1)
  const queryClient = useQueryClient()
  const queryRoot = ['work', ownerId]
  const inputRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const activeUpload = useRef<AbortController | null>(null)
  useEffect(() => () => activeUpload.current?.abort(), [])
  const [busy, setBusy] = useState(false)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const capabilities = useQuery({
    queryKey: [...queryRoot, 'capabilities'],
    queryFn: getWorkCapabilities,
    retry: false,
  })
  const materials = useQuery({
    queryKey: [...queryRoot, 'materials', page],
    queryFn: () => listMaterials(page),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.results.some(pending) ? 2500 : false,
  })
  const selected = useQuery({
    queryKey: [...queryRoot, 'material', selectedId],
    queryFn: () => getMaterial(selectedId),
    enabled: !!selectedId,
    retry: false,
    refetchInterval: (q) => (pending(q.state.data) ? 2500 : false),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryRoot })
  const canUpload = capabilities.data?.materials_enabled === true

  const setSelection = (id: string, nextPage = page) => {
    const query = new URLSearchParams()
    if (id) query.set('material', id)
    if (nextPage > 1) query.set('page', String(nextPage))
    navigate(`/work${query.size ? `?${query}` : ''}`)
    setConfirmDelete(false)
    setActionError('')
  }

  const uploadBatch = async (items: UploadItem[]) => {
    if (busyRef.current || !canUpload) return
    busyRef.current = true
    const controller = new AbortController()
    activeUpload.current = controller
    setBusy(true)
    setNotice('正在上传材料…')
    const next = [...items]
    let lastId = ''
    try {
      for (let i = 0; i < next.length; i++) {
        if (controller.signal.aborted) return
        if (next[i].done) continue
        try {
          const material = await uploadMaterial(
            next[i].file,
            next[i].key,
            controller.signal
          )
          if (controller.signal.aborted) return
          next[i] = { ...next[i], done: true, error: undefined }
          lastId = material.id
        } catch (error) {
          if (controller.signal.aborted) return
          next[i] = { ...next[i], error: workError(error) }
        }
        setUploads([...next])
      }
      const failures = next.filter((item) => !item.done).length
      setNotice(
        failures
          ? `${failures} 份上传失败，可保留文件重试。`
          : '材料已上传，解析完成后即可预览。'
      )
      await refresh()
      if (controller.signal.aborted) return
      if (lastId) setSelection(lastId, 1)
    } finally {
      busyRef.current = false
      activeUpload.current = null
      setBusy(false)
    }
  }

  const chooseFiles = (files: File[]) => {
    if (busyRef.current || !canUpload || !capabilities.data) return
    const limits = capabilities.data
    if (
      files.length > limits.max_batch_files ||
      files.reduce((n, f) => n + f.size, 0) > limits.max_batch_bytes
    ) {
      setNotice('每批最多上传 10 份、合计 30 MiB，请分批选择。')
      return
    }
    if (!files.length) return
    const items = files.map((file) => ({ file, key: crypto.randomUUID() }))
    setUploads(items)
    void uploadBatch(items)
  }

  const retry = useMutation({
    mutationFn: (item: Material) => retryMaterial(item, crypto.randomUUID()),
    onSuccess: () => {
      setActionError('')
      void refresh()
    },
    onError: (error) => {
      setActionError(workError(error))
      void refresh()
    },
  })
  const remove = useMutation({
    mutationFn: deleteMaterial,
    onSuccess: () => {
      queryClient.removeQueries({
        queryKey: [...queryRoot, 'preview', selectedId],
      })
      queryClient.removeQueries({
        queryKey: [...queryRoot, 'material', selectedId],
      })
      setSelection('', 1)
      void refresh()
      setNotice('材料已删除，不再可访问。')
    },
    onError: (error) => setActionError(workError(error)),
  })

  return (
    <section className="work-materials" aria-label="工作材料">
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">日常办公</p>
          <h1>工作材料</h1>
          <p>把背景和资料放在这里，为下一次工作做好准备。</p>
        </div>
        <button className="work-button" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      {capabilities.isError && (
        <p role="alert">
          工作配置加载失败。
          <button onClick={() => void capabilities.refetch()}>重试</button>
        </p>
      )}
      {capabilities.data && !canUpload && (
        <p role="status">材料上传暂未开放。你仍可查看和删除已有材料。</p>
      )}
      {canUpload && (
        <div
          className="work-dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            chooseFiles(Array.from(event.dataTransfer.files))
          }}
        >
          <RiUploadCloud2Line size={32} aria-hidden="true" />
          <div>
            <h2>上传工作材料</h2>
            <p>支持 UTF-8 编码的 TXT、Markdown；每份不超过 10 MiB。</p>
            <p>文件上传到云端处理，仅当前账号可见。可选择文件或拖放到此处。</p>
          </div>
          <button
            className="work-button work-primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? '上传中…' : '选择文件'}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={capabilities.data?.formats.join(',')}
            aria-label="上传工作材料"
            className="work-file-input"
            disabled={busy}
            onChange={(event) => {
              chooseFiles(Array.from(event.target.files || []))
              event.target.value = ''
            }}
          />
        </div>
      )}
      <p className="work-notice" role="status" aria-live="polite">
        {notice}
      </p>
      {uploads.some((item) => item.error) && (
        <div className="work-errors" role="alert">
          {uploads
            .filter((item) => item.error)
            .map((item) => (
              <p key={item.key}>
                {item.file.name}：{item.error}
              </p>
            ))}
          <button
            className="work-button"
            disabled={busy || !canUpload}
            onClick={() => void uploadBatch(uploads)}
          >
            重试失败上传
          </button>
        </div>
      )}
      <div className="work-columns">
        <section className="work-list" aria-label="我的材料">
          <h2>我的材料{materials.data ? `（${materials.data.count}）` : ''}</h2>
          {materials.isPending && <p role="status">正在加载材料…</p>}
          {materials.isError && (
            <p role="alert">
              {workError(materials.error)}
              <button onClick={() => setSelection('', 1)}>返回第一页</button>
              <button onClick={() => void materials.refetch()}>重试</button>
            </p>
          )}
          {materials.data?.count === 0 && (
            <div className="work-empty">
              <RiFileTextLine size={32} aria-hidden="true" />
              <p>还没有材料</p>
              <p>上传一份说明或进展记录，即可在这里核对内容。</p>
            </div>
          )}
          {materials.data?.results.map((item) => (
            <button
              key={item.id}
              className="work-material-row"
              aria-pressed={item.id === selectedId}
              onClick={() => setSelection(item.id)}
            >
              <RiFileTextLine size={22} aria-hidden="true" />
              <span>
                <strong>{item.original_name}</strong>
                <small>
                  {sizeLabel(item.size)} · {statusLabel[item.status]}
                </small>
              </span>
            </button>
          ))}
          {!!materials.data?.count && (
            <nav className="work-pagination" aria-label="材料分页">
              <button
                disabled={!materials.data.previous}
                onClick={() => setSelection('', page - 1)}
              >
                上一页
              </button>
              <span>第 {page} 页</span>
              <button
                disabled={!materials.data.next}
                onClick={() => setSelection('', page + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </section>
        <section className="work-detail" aria-label="材料预览">
          {!selectedId && (
            <div className="work-empty">
              <h2>核对材料内容</h2>
              <p>选择一份材料，查看解析状态与原文行号。</p>
            </div>
          )}
          {selectedId && selected.isPending && (
            <p role="status">正在读取材料…</p>
          )}
          {selectedId && selected.isError && (
            <p role="alert">
              {workError(selected.error)}
              <button onClick={() => void selected.refetch()}>重试</button>
            </p>
          )}
          {selected.data && !selected.isError && (
            <>
              <div className="work-detail-heading">
                <div>
                  <h2>{selected.data.original_name}</h2>
                  <p>
                    {statusLabel[selected.data.status]} ·{' '}
                    {sizeLabel(selected.data.size)} · 仅自己可见
                  </p>
                </div>
                <button
                  className="work-button"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除材料
                </button>
              </div>
              {actionError && <p role="alert">{actionError}</p>}
              {confirmDelete && (
                <div className="work-errors" role="alert">
                  <p>删除后将无法继续预览这份材料。</p>
                  <button
                    className="work-button"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(selected.data.id)}
                  >
                    确认删除
                  </button>
                  <button
                    className="work-button"
                    disabled={remove.isPending}
                    onClick={() => setConfirmDelete(false)}
                  >
                    保留材料
                  </button>
                </div>
              )}
              {pending(selected.data) && (
                <p role="status">
                  正在等待后台解析。你可以离开页面，稍后回来继续查看。
                </p>
              )}
              {selected.data.status === 'failed' && (
                <div role="alert">
                  <p>{workError(selected.data.error_code)}</p>
                  <button
                    className="work-button"
                    disabled={retry.isPending || !canUpload}
                    onClick={() => retry.mutate(selected.data)}
                  >
                    重试解析
                  </button>
                </div>
              )}
              {selected.data.status === 'ready' && (
                <MaterialText
                  key={`${selectedId}-${selected.data.generation}`}
                  item={selected.data}
                  ownerId={ownerId}
                />
              )}
            </>
          )}
        </section>
      </div>
    </section>
  )
}

const MaterialText = ({
  item,
  ownerId,
}: {
  item: Material
  ownerId: string
}) => {
  const [start, setStart] = useState(1)
  const preview = useQuery({
    queryKey: ['work', ownerId, 'preview', item.id, item.generation, start],
    queryFn: () => getMaterialPreview(item.id, start),
    retry: false,
  })
  if (preview.isPending) return <p role="status">正在加载原文…</p>
  if (preview.isError)
    return (
      <p role="alert">
        {workError(preview.error)}
        <button onClick={() => void preview.refetch()}>重试</button>
      </p>
    )
  return (
    <>
      <p className="work-muted">
        共 {preview.data.line_count} 行 · 显示第 {start}–
        {preview.data.lines.at(-1)?.number} 行
      </p>
      <div className="work-text" aria-label="材料原文">
        {preview.data.lines.map((line) => (
          <div className="work-text-line" key={line.number}>
            <span aria-label={`第 ${line.number} 行`}>{line.number}</span>
            <pre>
              {line.text}
              {line.truncated && <em>（本行预览仅显示前 2000 字符）</em>}
            </pre>
          </div>
        ))}
      </div>
      <nav className="work-pagination" aria-label="原文分页">
        <button
          disabled={start === 1}
          onClick={() => setStart(Math.max(1, start - 100))}
        >
          前 100 行
        </button>
        <button
          disabled={!preview.data.next_start}
          onClick={() => setStart(preview.data.next_start!)}
        >
          后 100 行
        </button>
      </nav>
    </>
  )
}
