import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import * as materials from '../api/materials'
import * as tasks from '../api/tasks'
import { AgentWork } from './AgentWork'

vi.mock('../api/reviews', () => ({
  listReviews: vi.fn().mockResolvedValue([]),
}))

vi.mock('./Communication', () => ({
  RunArtifacts: () => <div>成果编辑器</div>,
  RunProgress: () => <div>执行记录</div>,
}))
vi.mock('../api/materials', async (original) => ({
  ...(await original<typeof materials>()),
  getWorkCapabilities: vi.fn(),
  listMaterials: vi.fn(),
}))
vi.mock('../api/tasks', () => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  retryTask: vi.fn(),
  cancelRun: vi.fn(),
  listRunFiles: vi.fn(),
  downloadRunFile: vi.fn(),
}))

const material: materials.Material = {
  id: 'source-1',
  original_name: 'orders.csv',
  status: 'ready',
  checksum: 'a'.repeat(64),
  parser_version: 'plain-text-v1',
  generation: 1,
  size: 10,
  line_count: 2,
  error_code: '',
  created_at: '',
  updated_at: '',
}
const task: tasks.WorkTask = {
  id: 'task-1',
  kind: 'office_agent',
  recipient: '',
  goal: '分析选定订单',
  background: '',
  sources: [material],
  runs: [
    {
      id: 'run-1',
      status: 'running',
      model: 'deepseek-flash',
      error_code: '',
      reserved_tokens: 80000,
      input_tokens: null,
      output_tokens: null,
    },
  ],
}
const capabilities: materials.WorkCapabilities = {
  enabled: true,
  materials_enabled: true,
  agent_enabled: true,
  agent_model: 'deepseek-flash',
  formats: ['.csv'],
  max_file_bytes: 100,
  max_batch_files: 10,
  max_batch_bytes: 1000,
  skills: ['office_agent'],
}
function mount(view = 'new') {
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
      <AgentWork ownerId="owner" view={view} />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/work?view=new')
  vi.mocked(materials.getWorkCapabilities).mockResolvedValue(capabilities)
  vi.mocked(materials.listMaterials).mockResolvedValue({
    count: 1,
    next: null,
    previous: null,
    results: [material],
  })
  vi.mocked(tasks.listTasks).mockResolvedValue({
    results: [],
    next: null,
    previous: null,
  })
  vi.mocked(tasks.getTask).mockResolvedValue(task)
  vi.mocked(tasks.listRunFiles).mockResolvedValue([])
})

describe('Agent Work integration', () => {
  it('reuses admission key after an unknown response and sends selected material identity', async () => {
    vi.mocked(tasks.createTask).mockRejectedValue(
      new Error('unknown transport')
    )
    mount('spreadsheet')
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    await waitFor(() => expect(tasks.createTask).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(tasks.createTask).mock.calls
    expect(calls[0][0]).toMatchObject({
      kind: 'office_agent',
      sources: [
        { id: material.id, checksum: material.checksum, generation: 1 },
      ],
    })
    expect(calls[0][1]).toBe(calls[1][1])
    expect(tasks.listTasks).toHaveBeenCalledWith(1, 'office_agent')
  })
  it('uses server capability to disable generation', async () => {
    vi.mocked(materials.getWorkCapabilities).mockResolvedValue({
      ...capabilities,
      agent_enabled: false,
    })
    mount('weekly')
    expect(
      await screen.findByText('工作生成尚未启用。可以先上传并核对材料。')
    ).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('checkbox'))
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDisabled()
    expect(tasks.createTask).not.toHaveBeenCalled()
  })
  it('restores active run and cancels the same run', async () => {
    window.history.replaceState(null, '', '/work?view=new&task=task-1')
    vi.mocked(tasks.cancelRun).mockResolvedValue({
      ...task.runs[0],
      status: 'canceled',
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '取消处理' }))
    await waitFor(() => expect(tasks.cancelRun).toHaveBeenCalledWith('run-1'))
    expect(screen.getByText('执行记录')).toBeInTheDocument()
  })
  it('does not expose cached filenames after access is denied', async () => {
    window.history.replaceState(null, '', '/work?view=new&task=task-1')
    vi.mocked(tasks.getTask).mockResolvedValue({
      ...task,
      runs: [{ ...task.runs[0], status: 'succeeded' }],
    })
    vi.mocked(tasks.listRunFiles).mockRejectedValue(
      new ApiError(409, { code: 'source_unavailable' })
    )
    mount()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'orders.csv' })
    ).not.toBeInTheDocument()
  })
  it('keeps disconnected local execution cancellable without cloud retry', async () => {
    window.history.replaceState(null, '', '/work?view=new&task=task-1')
    vi.mocked(tasks.getTask).mockResolvedValue({
      ...task,
      runs: [
        {
          ...task.runs[0],
          status: 'disconnected',
          execution_target: 'local',
          workspace_label: 'selected folder',
          usage_origin: 'device_reported',
        },
      ],
    })
    vi.mocked(tasks.cancelRun).mockResolvedValue({
      ...task.runs[0],
      status: 'canceled',
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '取消处理' }))
    await waitFor(() => expect(tasks.cancelRun).toHaveBeenCalledWith('run-1'))
    expect(tasks.retryTask).not.toHaveBeenCalled()
    expect(screen.getByText(/成果正文保留在执行设备/)).toBeInTheDocument()
    expect(screen.queryByText('成果编辑器')).not.toBeInTheDocument()
  })
  it('shows synced local artifacts and labels device usage', async () => {
    window.history.replaceState(null, '', '/work?view=new&task=task-1')
    vi.mocked(tasks.getTask).mockResolvedValue({
      ...task,
      runs: [
        {
          ...task.runs[0],
          status: 'succeeded',
          execution_target: 'local',
          usage_origin: 'device_reported',
          input_tokens: 120,
          output_tokens: 20,
          synced_files: ['report.md'],
        },
      ],
    })
    mount()
    expect(await screen.findByText('成果编辑器')).toBeInTheDocument()
    expect(screen.getByText(/设备上报输入 120/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '请在执行设备创建新任务' })
    ).toBeDisabled()
  })
})
