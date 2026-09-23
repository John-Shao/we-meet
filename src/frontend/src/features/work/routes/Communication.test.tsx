import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import * as materials from '../api/materials'
import * as tasks from '../api/tasks'
import { Communication } from './Communication'

vi.mock('../api/materials', async (original) => ({
  ...(await original<typeof materials>()),
  getWorkCapabilities: vi.fn(),
  listMaterials: vi.fn(),
}))
vi.mock('../api/tasks', () => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  getRunEvents: vi.fn(),
  createTask: vi.fn(),
  retryTask: vi.fn(),
  cancelRun: vi.fn(),
  getArtifact: vi.fn(),
  saveArtifact: vi.fn(),
  adoptArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
}))

const material: materials.Material = {
  id: 'source-1',
  original_name: '背景.md',
  status: 'ready',
  checksum: 'a'.repeat(64),
  parser_version: 'plain-text-v1',
  generation: 1,
  size: 80,
  line_count: 2,
  error_code: '',
  created_at: '',
  updated_at: '',
}
const task: tasks.WorkTask = {
  id: 'task-1',
  recipient: '客户负责人',
  goal: '确认上线范围',
  background: '',
  sources: [material],
  runs: [
    {
      id: 'run-1',
      status: 'succeeded',
      error_code: '',
      model: 'test-model',
      reserved_tokens: 5000,
      input_tokens: 100,
      output_tokens: 50,
    },
  ],
}
const artifact: tasks.Artifact = {
  version: 1,
  body: '原始草稿 <script>alert(1)</script>',
  origin: 'generated',
  adopted_at: null,
  citations: [],
}

function mount() {
  return render(
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
      <Communication ownerId="owner" />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  window.history.replaceState(null, '', '/work?view=communication')
  vi.mocked(materials.getWorkCapabilities).mockResolvedValue({
    enabled: true,
    materials_enabled: true,
    communication_enabled: true,
    model: 'test-model',
    skills: ['communication'],
    formats: ['.md'],
    max_file_bytes: 1000,
    max_batch_files: 10,
    max_batch_bytes: 3000,
  })
  vi.mocked(materials.listMaterials).mockResolvedValue({
    count: 1,
    results: [material],
    next: null,
    previous: null,
  })
  vi.mocked(tasks.listTasks).mockResolvedValue({
    results: [task],
    next: null,
    previous: null,
  })
  vi.mocked(tasks.getTask).mockResolvedValue(task)
  vi.mocked(tasks.getArtifact).mockResolvedValue(artifact)
  vi.mocked(tasks.getRunEvents).mockResolvedValue({
    run: task.runs[0],
    events: [{ seq: 1, type: 'queued', created_at: '' }],
    next_after: 1,
  })
})

async function fill() {
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('沟通对象'), {
    target: { value: '客户负责人' },
  })
  fireEvent.change(screen.getByLabelText('沟通目标'), {
    target: { value: '确认上线范围' },
  })
}

describe('Communication lifecycle', () => {
  it('freezes source versions and reuses submit key after network failure', async () => {
    vi.mocked(tasks.createTask).mockRejectedValue(new Error('network'))
    mount()
    await fill()
    fireEvent.click(screen.getByRole('button', { name: '生成沟通草稿' }))
    await screen.findByText('请求失败，请检查网络后重试。')
    fireEvent.click(screen.getByRole('button', { name: '生成沟通草稿' }))
    await waitFor(() => expect(tasks.createTask).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(tasks.createTask).mock.calls
    expect(calls[0][1]).toBe(calls[1][1])
    expect(calls[0][0].sources).toEqual([
      {
        id: material.id,
        checksum: material.checksum,
        parser_version: material.parser_version,
        generation: 1,
      },
    ])
  })

  it('restores task and renders generated content without executing HTML', async () => {
    window.history.replaceState(
      null,
      '',
      '/work?view=communication&task=task-1'
    )
    const view = mount()
    expect(await screen.findByLabelText('编辑草稿')).toHaveValue(artifact.body)
    expect(view.container.querySelector('script')).toBeNull()
    expect(tasks.getTask).toHaveBeenCalledWith('task-1')
  })

  it('keeps unsaved edits on conflict and requires saving before adoption/download', async () => {
    window.history.replaceState(
      null,
      '',
      '/work?view=communication&task=task-1'
    )
    vi.mocked(tasks.saveArtifact).mockRejectedValue(
      new ApiError(409, { code: 'version_conflict' })
    )
    mount()
    const editor = await screen.findByLabelText('编辑草稿')
    fireEvent.change(editor, { target: { value: '本地修改' } })
    expect(screen.getByRole('button', { name: '采纳此版本' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载 Markdown' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/版本已变化/)
    expect(editor).toHaveValue('本地修改')
    expect(tasks.saveArtifact).toHaveBeenCalledWith('run-1', 1, '本地修改')
  })

  it('does not show artifact text when the source has been revoked', async () => {
    window.history.replaceState(
      null,
      '',
      '/work?view=communication&task=task-1'
    )
    vi.mocked(tasks.getArtifact).mockRejectedValue(
      new ApiError(409, { code: 'source_unavailable' })
    )
    mount()
    await screen.findByText(/引用的材料已删除/)
    expect(screen.queryByLabelText('编辑草稿')).not.toBeInTheDocument()
  })

  it('aborts in-flight submission on account workspace unmount', async () => {
    vi.mocked(tasks.createTask).mockImplementation(() => new Promise(() => {}))
    const view = mount()
    await fill()
    fireEvent.click(screen.getByRole('button', { name: '生成沟通草稿' }))
    await waitFor(() => expect(tasks.createTask).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(tasks.createTask).mock.calls[0][2]!
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('preserves an older successful draft when the latest run fails', async () => {
    window.history.replaceState(
      null,
      '',
      '/work?view=communication&task=task-1'
    )
    vi.mocked(tasks.getTask).mockResolvedValue({
      ...task,
      runs: [
        ...task.runs,
        {
          ...task.runs[0],
          id: 'run-2',
          status: 'failed',
          error_code: 'execution_unknown',
          input_tokens: null,
          output_tokens: null,
        },
      ],
    })
    mount()
    expect(await screen.findByLabelText('编辑草稿')).toHaveValue(artifact.body)
    expect(screen.getByText(/不会自动重复调用/)).toBeInTheDocument()
    expect(tasks.getArtifact).toHaveBeenCalledWith('run-1')
  })
})
