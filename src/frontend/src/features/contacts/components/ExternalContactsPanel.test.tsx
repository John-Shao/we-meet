import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExternalContactsPanel } from './ExternalContactsPanel'

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('@/components/ConfirmProvider', () => ({ useConfirm: () => mocks }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const account = {
  id: 'alice',
  full_name: 'Alice',
  organization: { name: 'Acme' },
  status: 'none',
  direction: 'none',
}
const mount = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ExternalContactsPanel onMessage={vi.fn().mockResolvedValue(undefined)} />
    </QueryClientProvider>
  )
beforeEach(() => {
  mocks.fetchApi.mockReset().mockResolvedValue([])
  mocks.alert.mockReset().mockResolvedValue(undefined)
})

it('区分联系人加载失败与空联系人，并允许重试', async () => {
  mocks.fetchApi.mockImplementation((path: string) =>
    path.endsWith('/requests/')
      ? Promise.resolve([])
      : Promise.reject(new Error('offline'))
  )
  const user = userEvent.setup()
  mount()
  await screen.findByText('picker.loadError')
  expect(screen.queryByText('external.empty')).toBeNull()
  mocks.fetchApi.mockResolvedValue([])
  await user.click(screen.getByRole('button', { name: 'picker.retry' }))
  await screen.findByText('external.empty')
})

it('联系人申请失败保留独立错误入口', async () => {
  mocks.fetchApi.mockImplementation((path: string) =>
    path.endsWith('/requests/')
      ? Promise.reject(new Error('offline'))
      : Promise.resolve([])
  )
  mount()
  await screen.findByText('external.requestsLoadError')
  expect(screen.getByText('external.empty')).toBeInTheDocument()
})

it('首次提示与查无结果不同，修改输入清除旧结果', async () => {
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByTestId('external-contact-add'))
  expect(screen.getByText('external.searchEmpty')).toBeInTheDocument()
  const input = screen.getByPlaceholderText('external.searchPlaceholder')
  await user.type(input, 'a@example.com')
  await user.click(screen.getByRole('button', { name: 'external.search' }))
  await screen.findByText('external.noMatch')
  mocks.fetchApi.mockResolvedValue([account])
  await user.click(screen.getByRole('button', { name: 'external.search' }))
  await screen.findByText('Alice')
  await user.type(input, 'b')
  expect(screen.queryByText('Alice')).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'external.sendRequest' })
  ).toBeNull()
})

it('旧查询迟到时不能覆盖新输入的状态', async () => {
  let resolveSearch!: (value: unknown) => void
  mocks.fetchApi.mockImplementation((path: string) =>
    path.includes('/search/')
      ? new Promise((resolve) => {
          resolveSearch = resolve
        })
      : Promise.resolve([])
  )
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByTestId('external-contact-add'))
  const input = screen.getByPlaceholderText('external.searchPlaceholder')
  await user.type(input, 'a@example.com')
  await user.click(screen.getByRole('button', { name: 'external.search' }))
  await user.type(input, 'b')
  resolveSearch([account])
  await waitFor(() =>
    expect(screen.getByText('external.searchEmpty')).toBeInTheDocument()
  )
  expect(screen.queryByText('Alice')).toBeNull()
})

it('发送申请期间禁用按钮，失败后保留结果且可重试', async () => {
  let rejectSend!: (reason: Error) => void
  mocks.fetchApi.mockImplementation(
    (path: string, options?: { method?: string }) =>
      options?.method === 'POST'
        ? new Promise((_, reject) => {
            rejectSend = reject
          })
        : Promise.resolve(path.includes('/search/') ? [account] : [])
  )
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByTestId('external-contact-add'))
  await user.type(
    screen.getByPlaceholderText('external.searchPlaceholder'),
    'a@example.com'
  )
  await user.click(screen.getByRole('button', { name: 'external.search' }))
  const send = await screen.findByRole('button', {
    name: 'external.sendRequest',
  })
  await user.dblClick(send)
  expect(send).toBeDisabled()
  expect(
    mocks.fetchApi.mock.calls.filter(
      ([, options]) => options?.method === 'POST'
    )
  ).toHaveLength(1)
  rejectSend(new Error('offline'))
  await waitFor(() => expect(send).toBeEnabled())
  expect(mocks.alert).toHaveBeenCalled()
  expect(screen.getByText('Alice')).toBeInTheDocument()
})
