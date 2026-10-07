import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { LocalWorkBridge, LocalJob } from '../api/local'
import { LocalWorkspaceWork } from './LocalWorkspaceWork'

vi.mock('../api/materials', () => ({
  listMaterials: vi.fn(async () => ({
    results: [],
    next: null,
    previous: null,
  })),
}))

const folder = { id: 'workspace-1', name: 'project', path: 'D:\\project' }
const job: LocalJob = {
  run_id: 'run-1',
  workspace_id: folder.id,
  workspace: folder.path,
  goal: '核对本地文件',
  state: 'running',
  error_code: '',
  result: null,
}
const bridge: LocalWorkBridge = {
  status: vi.fn(),
  updateRuntime: vi.fn(),
  rollbackRuntime: vi.fn(),
  configure: vi.fn(),
  pickWorkspace: vi.fn(),
  list: vi.fn(),
  registerRemoteWorkspace: vi.fn(),
  remoteInbox: vi.fn(),
  takeRemote: vi.fn(),
  submit: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  syncFiles: vi.fn(),
  openArtifact: vi.fn(),
  reviewApproval: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/work?view=new')
  window.weMeetDesktop = {
    isDesktop: true,
    platform: 'win32',
    localWork: bridge,
    getStatus: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    retry: vi.fn(),
    onStatus: vi.fn(),
  }
  vi.mocked(bridge.status).mockResolvedValue({
    configured: true,
    ready: true,
    model: 'deepseek-flash',
  })
  vi.mocked(bridge.list).mockResolvedValue([])
  vi.mocked(bridge.pickWorkspace).mockResolvedValue(folder)
  vi.mocked(bridge.get).mockResolvedValue(job)
})
afterEach(() => {
  delete window.weMeetDesktop
})
const mount = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        })
      }
    >
      <LocalWorkspaceWork ownerId="owner" view="new" />
    </QueryClientProvider>
  )

it('requires native folder authorization before submission', async () => {
  mount()
  await screen.findByText(/已连接 dsh/)
  fireEvent.change(screen.getByLabelText('工作目标'), {
    target: { value: '分析本地材料' },
  })
  expect(screen.getByRole('button', { name: '开始本地处理' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  expect(
    screen.getByRole('button', { name: '开始本地处理' })
  ).not.toBeDisabled()
})

it('reuses the same run UUID after a lost admission response, without passing a raw path', async () => {
  vi.mocked(bridge.submit).mockRejectedValue(
    new Error('local_transport_unknown')
  )
  mount()
  await screen.findByText(/已连接 dsh/)
  fireEvent.click(await screen.findByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.change(screen.getByLabelText('工作目标'), {
    target: { value: '分析本地材料' },
  })
  fireEvent.click(screen.getByRole('button', { name: '开始本地处理' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '开始本地处理' }))
  await waitFor(() => expect(bridge.submit).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(bridge.submit).mock.calls
  expect(calls[0][0]).toEqual(calls[1][0])
  expect(calls[0][0].workspace_id).toBe(folder.id)
  expect(calls[0][0]).not.toHaveProperty('workspace')
})

it('restores and cancels an active local task', async () => {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  vi.mocked(bridge.cancel).mockResolvedValue({ ...job, state: 'cancelled' })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '取消本地处理' }))
  await waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith(job.run_id))
})

it('renders file content as text and opens through the native bridge', async () => {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  vi.mocked(bridge.get).mockResolvedValue({
    ...job,
    state: 'succeeded',
    result: {
      summary: '完成',
      artifacts: [
        {
          name: 'report.md',
          text: '<script>unsafe()</script>',
          sha256: 'test',
        },
      ],
    },
  })
  const view = mount()
  expect(
    await screen.findByText('<script>unsafe()</script>')
  ).toBeInTheDocument()
  expect(view.container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '在本机打开成果文件' }))
  await waitFor(() =>
    expect(bridge.openArtifact).toHaveBeenCalledWith(job.run_id, 'report.md')
  )
})

it('uploads only files explicitly selected by the user', async () => {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  vi.mocked(bridge.get).mockResolvedValue({
    ...job,
    state: 'succeeded',
    coordination: {
      task_id: 'task-1',
      status: 'succeeded',
      synced: true,
      error: '',
      uploaded_files: [],
    },
    result: {
      summary: '完成',
      artifacts: [
        { name: 'report.md', text: 'public summary', sha256: 'a' },
        { name: 'private.csv', text: 'private data', sha256: 'b' },
      ],
    },
  })
  mount()
  const button = await screen.findByRole('button', {
    name: '同步所选成果到云端',
  })
  expect(button).toBeDisabled()
  expect(bridge.syncFiles).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'report.md' }))
  fireEvent.click(button)
  await waitFor(() =>
    expect(bridge.syncFiles).toHaveBeenCalledWith('run-1', ['report.md'])
  )
})

it('requires confirmation to resume an uncertain original admission', async () => {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  vi.mocked(bridge.get).mockResolvedValue({
    ...job,
    state: 'needs_confirmation',
    error_code: 'local_tracking_pending',
  })
  mount()
  expect(
    await screen.findByRole('button', { name: '继续登记原任务' })
  ).toBeDisabled()
  expect(bridge.submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.click(screen.getByRole('button', { name: '继续登记原任务' }))
  await waitFor(() =>
    expect(bridge.resume).toHaveBeenCalledWith('run-1', folder.id)
  )
})

it('reviews the immutable pending operation through native IPC after folder consent', async () => {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  const approval = { id: 'approval-id', sha256: 'a'.repeat(64), tool: 'pwsh', arguments: '{"command":"Get-Content input.txt"}' }
  vi.mocked(bridge.get).mockResolvedValue({ ...job, approvals: [approval] })
  vi.mocked(bridge.reviewApproval).mockResolvedValue(job)
  mount()
  const review = await screen.findByRole('button', { name: '审阅此次操作' })
  expect(review).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.click(review)
  await waitFor(() => expect(bridge.reviewApproval).toHaveBeenCalledWith('run-1', approval.id, approval.sha256))
})

it('requires folder opt-in before taking a remote request and passes only identifiers', async () => {
  vi.mocked(bridge.status).mockResolvedValue({ configured: true, ready: true, remote_enabled: true })
  vi.mocked(bridge.remoteInbox).mockResolvedValue([{ run_id: 'remote-run', workspace_id: folder.id, workspace_label: folder.name, goal: 'Remote goal' }])
  vi.mocked(bridge.registerRemoteWorkspace).mockResolvedValue({})
  vi.mocked(bridge.takeRemote).mockResolvedValue({ ...job, run_id: 'remote-run' })
  mount()
  const take = await screen.findByRole('button', { name: '审阅并领取' })
  expect(take).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.click(screen.getByRole('checkbox', { name: /允许远程请求/ }))
  await waitFor(() => expect(take).not.toBeDisabled())
  fireEvent.click(take)
  await waitFor(() => expect(bridge.takeRemote).toHaveBeenCalledWith('remote-run', folder.id))
  expect(bridge.submit).not.toHaveBeenCalled()
})
