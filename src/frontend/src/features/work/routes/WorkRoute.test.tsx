import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import * as api from '../api/materials'
import { WorkMaterials } from './WorkRoute'

vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'owner' } }),
}))
vi.mock('@/components/RequireAuth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/layout/Screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../api/materials', async (original) => ({
  ...(await original<typeof api>()),
  getWorkCapabilities: vi.fn(),
  listMaterials: vi.fn(),
  getMaterial: vi.fn(),
  getMaterialPreview: vi.fn(),
  uploadMaterial: vi.fn(),
  retryMaterial: vi.fn(),
  deleteMaterial: vi.fn(),
}))

const item: api.Material = {
  id: 'material-1',
  original_name: '客户背景.md',
  size: 123,
  checksum: 'test',
  status: 'ready',
  parser_version: 'plain-text-v1',
  line_count: 1,
  error_code: '',
  generation: 1,
  created_at: '',
  updated_at: '',
}
const capabilities: api.WorkCapabilities = {
  enabled: true,
  materials_enabled: true,
  formats: ['.txt', '.md'],
  max_file_bytes: 10 * 1024 * 1024,
  max_batch_files: 10,
  max_batch_bytes: 30 * 1024 * 1024,
  skills: [],
}
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
      <WorkMaterials ownerId="owner" />
    </QueryClientProvider>
  )

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/work')
  vi.mocked(api.getWorkCapabilities).mockResolvedValue(capabilities)
  vi.mocked(api.listMaterials).mockResolvedValue({
    count: 1,
    next: null,
    previous: null,
    results: [item],
  })
  vi.mocked(api.getMaterial).mockResolvedValue(item)
  vi.mocked(api.getMaterialPreview).mockResolvedValue({
    id: item.id,
    line_count: 1,
    next_start: null,
    lines: [{ number: 1, text: '<script>unsafe()</script>', truncated: false }],
  })
})

describe('Work material lifecycle', () => {
  it('restores selected material from URL and renders content as text', async () => {
    window.history.replaceState(null, '', `/work?material=${item.id}`)
    const view = mount()
    expect(
      await screen.findByText('<script>unsafe()</script>')
    ).toBeInTheDocument()
    expect(view.container.querySelector('script')).toBeNull()
    expect(api.getMaterial).toHaveBeenCalledWith(item.id)
  })

  it('retains a failed upload and reuses the same idempotency key', async () => {
    vi.mocked(api.uploadMaterial)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(item)
    mount()
    const input = await screen.findByLabelText('上传工作材料')
    const file = new File(['说明'], '说明.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: '重试失败上传' }))
    await waitFor(() => expect(api.uploadMaterial).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.uploadMaterial).mock.calls[0].slice(0, 2)).toEqual(
      vi.mocked(api.uploadMaterial).mock.calls[1].slice(0, 2)
    )
    expect(
      await screen.findByText('材料已上传，解析完成后即可预览。')
    ).toBeInTheDocument()
  })

  it('keeps successful files when retrying a partial batch', async () => {
    vi.mocked(api.uploadMaterial)
      .mockResolvedValueOnce(item)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(item)
    mount()
    fireEvent.change(await screen.findByLabelText('上传工作材料'), {
      target: {
        files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: '重试失败上传' }))
    await waitFor(() => expect(api.uploadMaterial).toHaveBeenCalledTimes(3))
    expect(vi.mocked(api.uploadMaterial).mock.calls[2][0].name).toBe('b.txt')
  })

  it('aborts the remaining batch when the account workspace unmounts', async () => {
    let finish!: (value: api.Material) => void
    vi.mocked(api.uploadMaterial).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = mount()
    fireEvent.change(await screen.findByLabelText('上传工作材料'), {
      target: {
        files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      },
    })
    await waitFor(() => expect(api.uploadMaterial).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(vi.mocked(api.uploadMaterial).mock.calls[0][2]?.aborted).toBe(true)
    finish(item)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.uploadMaterial).toHaveBeenCalledTimes(1)
  })

  it('hides upload when disabled but preserves private history', async () => {
    vi.mocked(api.getWorkCapabilities).mockResolvedValue({
      ...capabilities,
      materials_enabled: false,
    })
    mount()
    expect(
      await screen.findByText('材料上传暂未开放。你仍可查看和删除已有材料。')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '选择文件' })
    ).not.toBeInTheDocument()
    expect(await screen.findByText(item.original_name)).toBeInTheDocument()
  })

  it('does not show prior text after access is denied', async () => {
    window.history.replaceState(null, '', `/work?material=${item.id}`)
    vi.mocked(api.getMaterial).mockRejectedValue(new ApiError(404, {}))
    mount()
    expect(
      await screen.findByText('材料不存在或当前账号无权访问。')
    ).toBeInTheDocument()
    expect(api.getMaterialPreview).not.toHaveBeenCalled()
  })

  it('requires a concrete delete action and clears the preview afterwards', async () => {
    window.history.replaceState(null, '', `/work?material=${item.id}`)
    vi.mocked(api.deleteMaterial).mockResolvedValue(undefined)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '删除材料' }))
    expect(api.deleteMaterial).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    expect(
      await screen.findByText('材料已删除，不再可访问。')
    ).toBeInTheDocument()
    expect(vi.mocked(api.deleteMaterial).mock.calls[0][0]).toBe(item.id)
    expect(
      screen.queryByText('<script>unsafe()</script>')
    ).not.toBeInTheDocument()
  })
})
