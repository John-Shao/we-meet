import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { MeetingMaterialPreview } from './MeetingMaterialPreview'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('@/features/auth', () => ({
  useUser: () => ({ user: { id: 'viewer' } }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

it('loads viewer-specific minutes and removes the body and role on revocation', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  vi.mocked(fetchApi).mockResolvedValue({
    excerpt: 'Private decisions',
    role: 'editor',
  })
  const view = render(
    <QueryClientProvider client={client}>
      <MeetingMaterialPreview recordId="record" scope="minutes" />
    </QueryClientProvider>
  )
  await screen.findByText('Private decisions')
  expect(screen.getByText('collaboration.viewer_editor')).toBeInTheDocument()
  expect(vi.mocked(fetchApi).mock.calls[0][0]).toBe(
    'meeting-records/record/collaboration/minutes/preview/'
  )
  vi.mocked(fetchApi).mockRejectedValue(new ApiError(404, {}))
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['meeting-material-preview'] })
  })
  await waitFor(() =>
    expect(screen.queryByText('Private decisions')).not.toBeInTheDocument()
  )
  expect(
    screen.queryByText('collaboration.viewer_editor')
  ).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

it.each(['summary', 'human'] as const)(
  'fetches the fixed %s preview and rejects missing or substituted versions',
  async (kind) => {
    const version = '22222222-2222-4222-8222-222222222222'
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    vi.mocked(fetchApi).mockResolvedValue({
      excerpt: 'Frozen old minutes',
      role: 'reader',
      [`${kind}_id`]: version,
      identity_updated: true,
    })
    const view = render(
      <QueryClientProvider client={client}>
        <MeetingMaterialPreview
          recordId="record"
          scope="minutes"
          {...(kind === 'summary'
            ? { summaryId: version }
            : { humanId: version })}
        />
      </QueryClientProvider>
    )
    await screen.findByText('Frozen old minutes')
    expect(screen.getByText('recordAi.identityUpdated')).toBeInTheDocument()
    expect(vi.mocked(fetchApi).mock.lastCall?.[0]).toBe(
      `meeting-records/record/collaboration/minutes/preview/?${kind}_id=${version}`
    )
    for (const wrong of [undefined, '33333333-3333-4333-8333-333333333333']) {
      vi.mocked(fetchApi).mockResolvedValue({
        excerpt: 'Newer private minutes',
        role: 'manager',
        [`${kind}_id`]: wrong,
      })
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ['meeting-material-preview'],
        })
      })
      await waitFor(() =>
        expect(screen.queryByText('Frozen old minutes')).not.toBeInTheDocument()
      )
      expect(
        screen.queryByText('Newer private minutes')
      ).not.toBeInTheDocument()
      expect(
        screen.getByText('collaboration.previewUnavailable')
      ).toBeInTheDocument()
    }
    view.unmount()
    client.clear()
  }
)
