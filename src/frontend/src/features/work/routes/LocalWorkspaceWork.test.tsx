import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { LocalWorkBridge, LocalJob } from '../api/local'
import * as materialsApi from '../api/materials'
import * as reviewsApi from '../api/reviews'
import * as tasksApi from '../api/tasks'
import { LocalWorkspaceWork } from './LocalWorkspaceWork'

vi.mock('../api/materials', async (original) => ({
  ...(await original<typeof import('../api/materials')>()),
  getWorkCapabilities: vi.fn(),
  listMaterials: vi.fn(async () => ({
    results: [],
    next: null,
    previous: null,
  })),
}))
vi.mock('../api/reviews', () => ({
  listReviews: vi.fn(),
  createReview: vi.fn(),
  cancelReview: vi.fn(),
}))
vi.mock('../api/tasks', () => ({ listRunFiles: vi.fn() }))

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
  vi.mocked(materialsApi.getWorkCapabilities).mockResolvedValue({
    enabled: true,
    materials_enabled: true,
    formats: ['md'],
    max_file_bytes: 400000,
    max_batch_files: 8,
    max_batch_bytes: 400000,
    skills: [],
    review_enabled: true,
    review_token_budget: 20000,
  })
  vi.mocked(tasksApi.listRunFiles).mockResolvedValue([])
  vi.mocked(reviewsApi.listReviews).mockResolvedValue([])
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

function completedLocal(uploaded: string[] = []) {
  window.history.replaceState(null, '', '/work?view=new&localRun=run-1')
  vi.mocked(bridge.status).mockResolvedValue({
    configured: true,
    ready: true,
    coordination_enabled: true,
  })
  const completed: LocalJob = {
    ...job,
    state: 'succeeded',
    coordination: {
      task_id: 'task-1',
      status: 'succeeded',
      synced: true,
      error: '',
      uploaded_files: uploaded,
    },
    result: {
      summary: '本地完成',
      artifacts: [
        { name: 'report.md', text: 'Selected summary', sha256: 'a'.repeat(64) },
        {
          name: 'private.csv',
          text: 'Private local rows',
          sha256: 'b'.repeat(64),
        },
      ],
    },
  }
  vi.mocked(bridge.get).mockResolvedValue(completed)
  return completed
}

it('connects explicit local sync to separately authorized review and displays its usage', async () => {
  const completed = completedLocal()
  const file = { name: 'report.md', sha256: 'a'.repeat(64) }
  const review: reviewsApi.WorkReview = {
    id: 'review-1',
    source_run_id: 'run-1',
    status: 'succeeded',
    error_code: '',
    model: 'qwen3.8-flash',
    selection: [file],
    snapshot: [file],
    reserved_tokens: 130,
    input_tokens: 100,
    output_tokens: 30,
    report: {
      verdict: 'no_issues',
      summary: '复核已完成',
      findings: [],
      missing_information: [],
    },
  }
  vi.mocked(bridge.syncFiles).mockImplementation(async () => {
    completed.coordination!.uploaded_files = ['report.md']
    vi.mocked(tasksApi.listRunFiles).mockResolvedValue([file])
    return completed
  })
  vi.mocked(reviewsApi.createReview).mockImplementation(async () => {
    vi.mocked(reviewsApi.listReviews).mockResolvedValue([review])
    return review
  })
  mount()
  const sync = await screen.findByRole('group', {
    name: '选择要同步到云端的成果',
  })
  expect(screen.queryByRole('region', { name: '成果复核' })).toBeNull()
  expect(tasksApi.listRunFiles).not.toHaveBeenCalled()
  fireEvent.click(within(sync).getByLabelText('report.md'))
  fireEvent.click(
    within(sync).getByRole('button', { name: '同步所选成果到云端' })
  )
  const reviewSection = await screen.findByRole('region', { name: '成果复核' })
  await within(reviewSection).findByLabelText('report.md')
  expect(within(reviewSection).queryByText('private.csv')).toBeNull()
  expect(reviewsApi.createReview).not.toHaveBeenCalled()
  const start = within(reviewSection).getByRole('button', {
    name: '开启本次复核',
  })
  fireEvent.click(within(reviewSection).getByLabelText('report.md'))
  expect(start).toBeDisabled()
  fireEvent.click(
    within(reviewSection).getByLabelText(
      '同意将选定成果和本任务已授权材料发送至复核模型'
    )
  )
  await waitFor(() => expect(start).not.toBeDisabled())
  fireEvent.click(start)
  await within(reviewSection).findByText('实际输入 100 / 输出 30 tokens')
  expect(reviewsApi.createReview).toHaveBeenCalledWith(
    'run-1',
    [file],
    expect.any(String)
  )
  expect(bridge.syncFiles).toHaveBeenCalledWith('run-1', ['report.md'])
  expect(bridge.submit).not.toHaveBeenCalled()
})

it('refreshes cloud file identities after an uncertain second sync without starting a review', async () => {
  const completed = completedLocal(['report.md'])
  const file = { name: 'report.md', sha256: 'a'.repeat(64) }
  vi.mocked(tasksApi.listRunFiles).mockResolvedValue([file])
  vi.mocked(bridge.syncFiles).mockImplementation(async () => {
    vi.mocked(tasksApi.listRunFiles).mockResolvedValue([
      file,
      { name: 'private.csv', sha256: 'b'.repeat(64) },
    ])
    throw new Error('local_transport_unknown')
  })
  mount()
  const reviewSection = await screen.findByRole('region', { name: '成果复核' })
  await within(reviewSection).findByLabelText('report.md')
  const sync = screen.getByRole('group', { name: '选择要同步到云端的成果' })
  fireEvent.click(within(sync).getByLabelText('private.csv'))
  fireEvent.click(
    within(sync).getByRole('button', { name: '同步所选成果到云端' })
  )
  await within(reviewSection).findByLabelText('private.csv')
  expect(reviewsApi.createReview).not.toHaveBeenCalled()
  expect(bridge.syncFiles).toHaveBeenCalledTimes(1)
  expect(completed.coordination!.uploaded_files).toEqual(['report.md'])
})

it('does not carry a file sharing selection into another local task', async () => {
  const first = completedLocal()
  const second = { ...first, run_id: 'run-2', goal: '另一条本地任务' }
  vi.mocked(bridge.list).mockResolvedValue([first, second])
  vi.mocked(bridge.get).mockImplementation(async (id) =>
    id === 'run-2' ? second : first
  )
  mount()
  const firstGroup = await screen.findByRole('group', {
    name: '选择要同步到云端的成果',
  })
  fireEvent.click(within(firstGroup).getByLabelText('report.md'))
  expect(within(firstGroup).getByLabelText('report.md')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: /^另一条本地任务/ }))
  await waitFor(() => expect(bridge.get).toHaveBeenCalledWith('run-2'))
  await screen.findByRole('heading', { name: '另一条本地任务' })
  expect(
    within(
      screen.getByRole('group', { name: '选择要同步到云端的成果' })
    ).getByLabelText('report.md')
  ).not.toBeChecked()
  expect(
    screen.getByRole('button', { name: '同步所选成果到云端' })
  ).toBeDisabled()
  expect(bridge.syncFiles).not.toHaveBeenCalled()
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
  const approval = {
    id: 'approval-id',
    sha256: 'a'.repeat(64),
    tool: 'pwsh',
    arguments: '{"command":"Get-Content input.txt"}',
  }
  vi.mocked(bridge.get).mockResolvedValue({ ...job, approvals: [approval] })
  vi.mocked(bridge.reviewApproval).mockResolvedValue(job)
  mount()
  const review = await screen.findByRole('button', { name: '审阅此次操作' })
  expect(review).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.click(review)
  await waitFor(() =>
    expect(bridge.reviewApproval).toHaveBeenCalledWith(
      'run-1',
      approval.id,
      approval.sha256
    )
  )
})

it('requires folder opt-in before taking a remote request and passes only identifiers', async () => {
  vi.mocked(bridge.status).mockResolvedValue({
    configured: true,
    ready: true,
    remote_enabled: true,
  })
  vi.mocked(bridge.remoteInbox).mockResolvedValue([
    {
      run_id: 'remote-run',
      workspace_id: folder.id,
      workspace_label: folder.name,
      goal: 'Remote goal',
    },
  ])
  vi.mocked(bridge.registerRemoteWorkspace).mockResolvedValue({})
  vi.mocked(bridge.takeRemote).mockResolvedValue({
    ...job,
    run_id: 'remote-run',
  })
  mount()
  const take = await screen.findByRole('button', { name: '审阅并领取' })
  expect(take).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '选择本地文件夹' }))
  await screen.findByText(/当前工作空间/)
  fireEvent.click(screen.getByRole('checkbox', { name: /允许远程请求/ }))
  await waitFor(() => expect(take).not.toBeDisabled())
  fireEvent.click(take)
  await waitFor(() =>
    expect(bridge.takeRemote).toHaveBeenCalledWith('remote-run', folder.id)
  )
  expect(bridge.submit).not.toHaveBeenCalled()
})
