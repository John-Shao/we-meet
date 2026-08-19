import { fetchApi } from '@/api/fetchApi'

/**
 * 批量导入 / 导出。
 *
 * Backend source: src/backend/core/api/admin_import.py.
 * 导入是**两次请求**:上传只做预检,确认后才落库 —— 一列映射错就足以悄悄重塑
 * 一个几百人的通讯录,所以中间必须有一步「先看清楚」。
 */

export type ImportJobStatus =
  | 'pending'
  | 'previewing'
  | 'previewed'
  | 'applying'
  | 'done'
  | 'partial'
  | 'failed'

export type RowAction = 'create' | 'update' | 'rehire' | 'invite' | 'error'

export interface ImportRow {
  /** CSV 行号(表头是第 1 行)。 */
  line: number
  action: RowAction
  label: string
  errors: string[]
  warnings: string[]
}

export interface ImportSummary {
  total: number
  warnings: number
  create: number
  update: number
  rehire: number
  invite: number
  error: number
  /** 只有 apply 之后才有。 */
  applied?: Record<string, number>
}

export interface ImportJob {
  id: string
  filename: string
  status: ImportJobStatus
  create_missing_departments: boolean
  rows: ImportRow[]
  summary: ImportSummary | Record<string, never>
  error: string
  applied_at: string | null
  created_at: string
}

/** 上传 CSV 并跑预检。返回的 job 已经带上逐行预览。 */
export const uploadImportFile = async (
  file: File,
  createMissingDepartments: boolean
): Promise<ImportJob> => {
  const form = new FormData()
  form.append('file', file)
  form.append(
    'create_missing_departments',
    createMissingDepartments ? 'true' : 'false'
  )
  // 不设 Content-Type:交给浏览器带上 multipart 的 boundary,手写会漏掉它。
  return fetchApi<ImportJob>('/admin/import-jobs/', {
    method: 'POST',
    body: form,
  })
}

/**
 * 确认落库。`expectedTotal` 回传屏幕上看到的行数 —— 对不上服务端会拒,免得
 * 应用一份管理员没读过的预览。
 */
export const applyImportJob = (
  id: string,
  expectedTotal: number
): Promise<ImportJob> =>
  fetchApi<ImportJob>(`/admin/import-jobs/${id}/apply/`, {
    method: 'POST',
    body: JSON.stringify({ expected_total: expectedTotal }),
  })

export const fetchImportJob = (id: string): Promise<ImportJob> =>
  fetchApi<ImportJob>(`/admin/import-jobs/${id}/`)

export const fetchImportJobs = (): Promise<ImportJob[]> =>
  fetchApi<ImportJob[]>('/admin/import-jobs/')

/** 模板与导出走浏览器下载,不经 fetchApi(响应是文件流不是 JSON)。 */
export const IMPORT_TEMPLATE_PATH = '/api/v1.0/admin/import-jobs/template/'
export const MEMBER_EXPORT_PATH = '/api/v1.0/admin/member-export/'
