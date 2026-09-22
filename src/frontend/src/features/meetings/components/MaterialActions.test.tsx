import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { MaterialActions } from './MaterialActions'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/features/im/components/ShareToChatDialog', () => ({
  ShareToChatDialog: ({ body }: { body: string }) => <output>{body}</output>,
}))
let client: QueryClient
let revision = 0
const member = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Teammate',
  role: 'reader',
  active: true,
}
const posts = () =>
  vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MaterialActions
        viewerId="viewer"
        recordId="record"
        scope="record"
        title="Review"
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  sessionStorage.clear()
  revision = 0
  vi.mocked(fetchApi).mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') return {}
    return {
      scope: 'record',
      record_id: 'record',
      revision,
      can_manage: true,
      is_owner: true,
      results: [member],
      count: 1,
      link_scope: 'private',
      can_link_organization: true,
    }
  })
})
afterEach(() => {
  client.clear()
  vi.clearAllMocks()
})

it('keeps sharing separate from permissions and sends the recording scope without granting access', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.share' }))
  expect(
    screen.getByRole('button', { name: 'collaboration.copy' })
  ).toBeInTheDocument()
  expect(
    screen.queryByText('collaboration.permissions')
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.send' }))
  expect(screen.getByRole('status').textContent).toContain('"scope":"record"')
  expect(posts()).toHaveLength(0)
})

it('keeps the opening revision when permissions change during a confirmation', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.manage' }))
  fireEvent.change(await screen.findByRole('combobox', { name: 'Teammate' }), {
    target: { value: 'editor' },
  })
  revision = 3
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['material-collaboration'] })
  })
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.confirm' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0][1]?.body)).expected_revision).toBe(0)
})

it('retries an uncertain change with the identical key and body', async () => {
  const baseline = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') throw new TypeError('network')
    return baseline(url, options)
  })
  show()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.manage' }))
  fireEvent.change(await screen.findByRole('combobox', { name: 'Teammate' }), {
    target: { value: 'editor' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.confirm' }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'collaboration.retry' })
    ).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.retry' }))
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[1][1]).toEqual(posts()[0][1])
})

it('hides collaborators after permission is revoked', async () => {
  show()
  fireEvent.click(screen.getByRole('button', { name: 'collaboration.manage' }))
  await screen.findByText('Teammate')
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(404, {}))
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['material-collaboration'] })
  })
  await waitFor(() =>
    expect(screen.queryByText('Teammate')).not.toBeInTheDocument()
  )
  expect(posts()).toHaveLength(0)
})
