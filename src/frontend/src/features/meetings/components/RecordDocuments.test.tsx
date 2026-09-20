import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordDocuments } from './RecordDocuments'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/api/fetchApi', () => ({ fetchApi: mocks.fetchApi }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
const receipt = {
  id: 'export',
  source_id: 'version',
  source_kind: 'ai',
  language: 'en',
  status: 'ready',
  can_open: true,
  document_id: 'doc',
  created_at: '2026-09-20T00:00:00Z',
}
function show(viewerId = 'owner') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordDocuments viewerId={viewerId} recordId="record" />
    </QueryClientProvider>
  )
}
afterEach(() => {
  client?.clear()
  vi.resetAllMocks()
})

it('opens the existing document and exact source version without creating an export', async () => {
  mocks.fetchApi.mockResolvedValue({ available: false, results: [receipt] })
  show()
  expect(
    await screen.findByRole('link', { name: 'summaryExport.openDocument' })
  ).toHaveAttribute('href', '/docs/doc')
  expect(
    screen.getByRole('link', { name: 'recordDocuments.source' })
  ).toHaveAttribute('href', '/meeting/records/record?summary=version')
  expect(
    mocks.fetchApi.mock.calls.every(([, options]) => !options.method)
  ).toBe(true)
})

it.each([
  { status: 'uncertain', can_open: true },
  { status: 'ready', can_open: false },
  { status: 'ready', document_id: null },
])('does not open an unavailable document: %j', async (override) => {
  mocks.fetchApi.mockResolvedValue({ results: [{ ...receipt, ...override }] })
  show()
  await screen.findByRole('link', { name: 'recordDocuments.source' })
  expect(
    screen.queryByRole('link', { name: 'summaryExport.openDocument' })
  ).toBeNull()
})

it('removes cached document links after a failed permission refresh', async () => {
  mocks.fetchApi.mockResolvedValue({ results: [receipt] })
  show()
  await screen.findByRole('link', { name: 'summaryExport.openDocument' })
  mocks.fetchApi.mockRejectedValue(new Error('Access revoked'))
  await client.invalidateQueries({
    queryKey: ['summary-exports', 'owner', 'record'],
  })
  await screen.findByText('library.loadError')
  expect(screen.queryByRole('link')).toBeNull()
})

it('does not reuse a previous viewer’s document links', async () => {
  mocks.fetchApi.mockResolvedValue({ results: [receipt] })
  const view = show()
  await screen.findByRole('link', { name: 'summaryExport.openDocument' })
  mocks.fetchApi.mockResolvedValue({ results: [] })
  view.rerender(
    <QueryClientProvider client={client}>
      <RecordDocuments viewerId="reader" recordId="record" />
    </QueryClientProvider>
  )
  await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
  await screen.findByText('recordDocuments.empty')
})
