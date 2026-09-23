import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'

export interface WorkCapabilities {
  enabled: boolean
  materials_enabled: boolean
  formats: string[]
  max_file_bytes: number
  max_batch_files: number
  max_batch_bytes: number
  skills: string[]
  communication_enabled?: boolean
  model?: string
}

export interface Material {
  id: string
  original_name: string
  size: number
  checksum: string
  status: 'uploaded' | 'parsing' | 'ready' | 'failed'
  parser_version: string
  line_count: number
  error_code: string
  generation: number
  created_at: string
  updated_at: string
}

export interface MaterialPage {
  count: number
  next: string | null
  previous: string | null
  results: Material[]
}

export interface MaterialPreview {
  id: string
  line_count: number
  lines: {
    number: number
    text: string
    truncated: boolean
    location?: string
  }[]
  next_start: number | null
}

export const getWorkCapabilities = () =>
  fetchApi<WorkCapabilities>('work/capabilities/')
export const listMaterials = (page: number) =>
  fetchApi<MaterialPage>(`work/materials/?page=${page}`)
export const getMaterial = (id: string) =>
  fetchApi<Material>(`work/materials/${encodeURIComponent(id)}/`)
export const getMaterialPreview = (id: string, start: number) =>
  fetchApi<MaterialPreview>(
    `work/materials/${encodeURIComponent(id)}/preview/?start=${start}`
  )
export const uploadMaterial = (
  file: File,
  key: string,
  signal?: AbortSignal
) => {
  const body = new FormData()
  body.append('file', file)
  return fetchApi<Material>('work/materials/', {
    method: 'POST',
    body,
    signal,
    headers: { 'Idempotency-Key': key },
  })
}
export const retryMaterial = (item: Material, key: string) =>
  fetchApi<Material>(`work/materials/${item.id}/retry/`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ generation: item.generation }),
  })
export const deleteMaterial = (id: string) =>
  fetchApi<void>(`work/materials/${id}/`, { method: 'DELETE' })

const errors: Record<string, string> = {
  unsupported_format: '请上传 TXT、Markdown、文本型 PDF 或 DOCX 文件。',
  invalid_document: '文件格式或内容无效，请重新导出后上传。',
  encrypted_document: '暂不支持加密文件，请上传未加密的材料。',
  pdf_ocr_required: 'PDF 存在无法提取文字的页面，请先完成 OCR 或另存为文本。',
  unsupported_document_content:
    'DOCX 含暂不支持的图片、修订、页眉页脚或嵌入内容，请核对后导出纯文本。',
  document_limit_exceeded: '文档页数、解压大小或解析资源超限，请拆分后上传。',
  parser_limits_unavailable: '文档解析隔离环境不可用，请联系管理员。',
  context_too_large: '选中材料超过完整读取范围，请减少材料或拆分为更短的文本。',
  source_unavailable:
    '引用的材料已删除、变更或不可访问，无法继续读取成果。请重新选择材料创建任务。',
  generation_unavailable: '沟通生成未启用或模型配置已变化，请稍后重试。',
  budget_exceeded: '今日生成额度不足，请明天再试或联系管理员调整额度。',
  task_material_limit: '选中材料合计超过 30 MiB，请减少材料。',
  execution_unknown:
    '此次执行未能确认完成，不会自动重复调用。重新生成会新增一次用量。',
  invalid_model_output: '模型未返回完整且有效的草稿，可重新生成。',
  invalid_citation: '模型引用与材料原文不符，草稿未交付，可重新生成。',
  run_active: '已有任务正在生成，请等待或取消后重试。',
  version_conflict:
    '版本已变化。请读取最新版本，比较后再保存；当前修改已保留。',
  artifact_not_ready: '草稿尚未就绪，请稍后刷新。',
  task_run_limit: '本任务已达 20 次运行上限，请创建新任务。',
  artifact_version_limit: '已达 100 个版本上限，请下载保存后创建新任务。',
  invalid_filename: '文件名无效，请修改文件名后重试。',
  file_too_large: '文件超过 10 MiB，请拆分后上传。',
  empty_file: '文件为空，请检查后重新上传。',
  empty_text: '未找到可读取的文字，请检查文件内容。',
  not_text: '文件包含二进制内容，无法按文本解析。',
  unsupported_encoding: '无法按 UTF-8 读取，请将文件另存为 UTF-8 后重新上传。',
  text_limit_exceeded: '文字超过 20 万字符或 5 万行，请拆分材料后上传。',
  material_quota_exceeded:
    '材料空间已满（最多 100 份、100 MiB），请删除不再需要的材料。',
  idempotency_conflict: '请求内容与之前提交不一致，请重新检查输入后提交。',
  upload_deleted: '这次上传的材料已被删除，请重新选择文件。',
  upload_unavailable: '上传服务暂不可用，请重试；已受理的文件不会重复创建。',
  parse_unavailable: '暂时无法读取文件，请重试解析。',
  source_changed: '文件校验不一致，请删除后重新上传。',
  access_revoked: '账号或组织权限已变化，无法继续处理这项工作。',
  stale_material: '材料状态已更新，请刷新后再试。',
  material_not_failed: '材料状态已变化，请刷新查看。',
}

export const workError = (error: unknown): string => {
  if (typeof error === 'string') return errors[error] || '处理失败，请重试。'
  if (error instanceof ApiError) {
    if (error.statusCode === 401 || error.statusCode === 403)
      return '登录或访问权限已变化，请重新登录后再试。'
    if (error.statusCode === 404) return '材料不存在或当前账号无权访问。'
    const code = (error.body as { code?: string } | null)?.code
    if (code && errors[code]) return errors[code]
  }
  return '请求失败，请检查网络后重试。'
}
