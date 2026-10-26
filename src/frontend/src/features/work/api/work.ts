import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'

export interface WorkCapabilities {
  enabled: boolean
  skills: string[]
  agent_enabled?: boolean
  agent_model?: string
  agent_max_context_bytes?: number
  agent_token_budget?: number
  review_enabled?: boolean
  review_model?: string
  review_token_budget?: number
  local_agent_enabled?: boolean
  coordination_contract?: string
  remote_agent_enabled?: boolean
  daily_token_budget?: number
}

export const getWorkCapabilities = () =>
  fetchApi<WorkCapabilities>('work/capabilities/')

const errors: Record<string, string> = {
  agent_unavailable: '执行服务暂不可用，已登记的任务不会重复创建。',
  review_unavailable: '复核服务暂不可用。',
  review_requires_success: '请在任务成功完成后开启复核。',
  review_active: '本次成果已有复核正在进行。',
  review_limit: '本次成果已达 5 次复核上限。',
  review_file_unavailable: '选定文件尚未同步或版本已变化，请重新选择。',
  invalid_review_report: '复核结果未通过证据校验，请核对原始成果。',
  agent_contract_mismatch: '执行服务版本不兼容，请联系管理员更新。',
  agent_failed: '此次处理未完成，请查看执行记录后创建新任务。',
  deployment_changed: '执行配置已变化，此任务不会自动重跑。',
  deadline_exceeded: '此次处理已超时，可核对本机文件后创建新任务。',
  local_device_disconnected:
    '执行设备已断线，等待原设备回报，不会自动转到云端重跑。',
  local_retry_requires_new_task: '本地任务请在原执行设备上创建新任务。',
  generation_unavailable: '工作生成未启用或模型配置已变化，请稍后重试。',
  budget_exceeded: '今日生成额度不足，请明天再试或联系管理员调整额度。',
  execution_unknown:
    '此次执行未能确认完成，不会自动重复调用。重新生成会新增一次用量。',
  invalid_model_output: '模型未返回完整且有效的成果，可重新生成。',
  run_active: '已有任务正在生成，请等待或取消后重试。',
  version_conflict:
    '版本已变化。请读取最新版本，比较后再保存；当前修改已保留。',
  artifact_not_ready: '成果尚未就绪，请稍后刷新。',
  task_run_limit: '本任务已达 20 次运行上限，请创建新任务。',
  artifact_version_limit: '已达 100 个版本上限，请下载保存后创建新任务。',
  invalid_filename: '文件名无效，请修改文件名后重试。',
  idempotency_conflict: '请求内容与之前提交不一致，请重新检查输入后提交。',
  access_revoked: '账号或组织权限已变化，无法继续处理这项工作。',
}

export const workError = (error: unknown): string => {
  if (typeof error === 'string') return errors[error] || '处理失败，请重试。'
  if (error instanceof ApiError) {
    if (error.statusCode === 401 || error.statusCode === 403)
      return '登录或访问权限已变化，请重新登录后再试。'
    if (error.statusCode === 404) return '任务不存在或当前账号无权访问。'
    const code = (error.body as { code?: string } | null)?.code
    if (code && errors[code]) return errors[code]
  }
  return '请求失败，请检查网络后重试。'
}
