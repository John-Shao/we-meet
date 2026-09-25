import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { TranslationArchivePanel } from './TranslationArchivePanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
let denied: boolean
let wrongArchive: boolean
const calls = () => vi.mocked(fetchApi).mock.calls.map(([path]) => path)
const show = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TranslationArchivePanel
        key="viewer:record"
        viewerId="viewer"
        recordId="record"
      />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  denied = wrongArchive = false
  vi.mocked(fetchApi).mockReset()
  vi.mocked(fetchApi).mockImplementation(async (path) => {
    if (denied) throw new ApiError(403, {})
    if (path.includes('translation-archives/'))
      return {
        results: [
          {
            id: 'archive',
            target: 'en',
            generation: 2,
            status: 'incomplete',
            segment_count: 51,
            created_at: '2026-09-13T00:00:00Z',
          },
        ],
        next_cursor: null,
      }
    const next = path.includes('cursor=next')
    return {
      archive_id: wrongArchive ? 'other' : 'archive',
      archive_status: 'incomplete',
      target: 'en',
      results: [
        {
          id: next ? 'second' : 'first',
          sequence: next ? 51 : 1,
          target: 'en',
          text: next ? 'Last confirmed translation' : 'Saved decision',
          speaker_label: 'Speaker',
          received_at: '2026-09-13T00:00:01Z',
          timing_basis: 'delivery',
          original_id: null,
        },
      ],
      next_cursor: next ? null : 'next',
    }
  })
})
afterEach(() => client?.clear())
describe('Retained translation reader', () => {
  it('requires selecting an archive and presents partial content without playback claims', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'open' }))
    expect(await screen.findByText('Saved decision')).toBeInTheDocument()
    expect(screen.getByText('timingHint')).toBeInTheDocument()
    expect(screen.getByText('incompleteHint')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /play|seek/i })
    ).not.toBeInTheDocument()
    expect(
      calls().filter((path) => path.includes('translation-segments/'))[0]
    ).toContain('archive_id=archive')
  })
  it('appends segments inside the chosen archive and retains earlier text', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'open' }))
    await screen.findByText('Saved decision')
    fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
    await screen.findByText('Last confirmed translation')
    expect(screen.queryByText('Saved decision')).toBeInTheDocument()
    expect(calls().at(-1)).toContain('archive_id=archive&cursor=next')
  })
  it('hides cached translations after permission revocation', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'open' }))
    await screen.findByText('Saved decision')
    denied = true
    await act(() => client.invalidateQueries())
    await waitFor(() =>
      expect(screen.queryByText('Saved decision')).not.toBeInTheDocument()
    )
    expect(screen.getByRole('alert')).toHaveTextContent('error')
  })
  it('rejects a mismatched archive response rather than showing another meeting source', async () => {
    wrongArchive = true
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'open' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('error')
    expect(screen.queryByText('Saved decision')).not.toBeInTheDocument()
  })
})
