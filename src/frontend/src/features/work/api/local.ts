export interface LocalWorkspace {
  id: string
  path: string
  name: string
}
export interface LocalJob {
  run_id: string
  state:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_confirmation'
  goal: string
  workspace: string
  workspace_id: string
  error_code: string
  approvals?: { id: string; sha256: string; tool: string; arguments: string }[]
  coordination?: {
    task_id?: string
    status?: string
    synced: boolean
    error: string
    uploaded_files: string[]
  }
  result?: {
    summary: string
    artifacts: { name: string; text: string; sha256: string }[]
  } | null
  metering?: {
    calls: number
    complete: boolean
    usage: {
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
    } | null
  }
}
export interface LocalCapabilities {
  configured?: boolean
  ready?: boolean
  model?: string
  runtime_version?: string
  execution?: string
  coordination_enabled?: boolean
  remote_enabled?: boolean
  bundled_runtime?: boolean
  runtime?: {
    version: string
    previous?: string
    signed_updates_enabled: boolean
  }
}
export interface LocalWorkBridge {
  status(): Promise<LocalCapabilities>
  updateRuntime(): Promise<unknown>
  rollbackRuntime(): Promise<unknown>
  configure(model: string): Promise<LocalCapabilities | null>
  pickWorkspace(): Promise<LocalWorkspace | null>
  list(): Promise<LocalJob[]>
  registerRemoteWorkspace(id: string, enabled: boolean): Promise<unknown>
  remoteInbox(): Promise<
    {
      run_id: string
      workspace_id: string
      workspace_label: string
      goal: string
    }[]
  >
  takeRemote(id: string, workspaceId: string): Promise<LocalJob | null>
  submit(body: {
    run_id: string
    workspace_id: string
    goal: string
    track_cloud?: boolean
    sources?: {
      id: string
      checksum: string
      parser_version: string
      generation: number
    }[]
  }): Promise<LocalJob>
  get(runId: string): Promise<LocalJob>
  cancel(runId: string): Promise<LocalJob>
  resume(runId: string, workspaceId: string): Promise<LocalJob>
  syncFiles(runId: string, names: string[]): Promise<LocalJob>
  reviewApproval(runId: string, id: string, sha256: string): Promise<LocalJob>
  openArtifact(runId: string, name: string): Promise<void>
}

const errors: Record<string, string> = {
  runtime_tasks_active: '请先完成或取消本机任务，再升级或回退执行器。',
  runtime_signing_unconfigured:
    '尚未配置正式升级签名，当前仅支持随客户端安装的内部测试版本。',
  runtime_integrity_failed: '运行环境校验失败，请重新安装完整的客户端。',
  runtime_signature_invalid: '升级包签名不受信任，未切换运行环境。',
  runtime_version_conflict: '此版本已存在，请使用新的版本号发布升级包。',
  runtime_rollback_unavailable: '尚无可回退的已验证版本。',
  approval_denied: '此次操作未获批准，任务已停止。',
  approval_unavailable: '此审批已过期或任务已停止，请刷新原任务。',
  remote_coordination_disabled: '服务端尚未启用远程任务派发。',
  local_assignment_closed: '此请求已关闭或被领取，请查询原任务。',
  local_tracking_pending:
    '原任务登记或领取尚待确认。请重新授权原目录后继续原任务，避免重复执行。',
  local_cloud_pending:
    '云端记录暂未同步。本机任务继续保留，恢复连接后重试状态回报。',
  local_adapter_upgrade_required: '请更新本机执行器，以支持逐次命令审批。',
  local_task_not_registered: '此任务仅在本机执行，尚未登记云端记录。',
  local_coordination_disabled:
    '服务端尚未启用客户端任务登记，可选择仅在本机执行。',
  local_setup_required: '请先配置本机 dsh 执行器。',
  local_runtime_unavailable:
    '本机执行器或模型配置不可用，请检查独立运行时安装。',
  local_transport_unknown:
    '与本机执行器的连接中断。请刷新查询原任务，避免重复生成。',
  workspace_permission_required: '请重新选择并授权此本地工作空间。',
  artifact_changed: '文件已修改或位置已变化，请在本地工作空间中核对。',
  local_login_required: '请先登录桌面客户端。',
  local_busy: '执行器配置正在更新，请稍后重试。',
  invalid_key_file: '所选文件需要包含一行 DEEPSEEK_API_KEY 配置。',
  local_execution_failed: '本地执行失败，请核对目标、文件和模型配置。',
  budget_exceeded: '本次模型调用已达到预算上限。',
  deadline_exceeded: '本地执行超时，请缩小工作范围后重新发起。',
}
export const localError = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  const code = Object.keys(errors).find((key) => text.includes(key))
  return code ? errors[code] : '本地操作失败，请检查执行器配置后重试。'
}
