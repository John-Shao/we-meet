import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { UploadTranslationPanel } from './UploadTranslationPanel'

vi.mock('@/api/fetchApi', () => ({ fetchApi: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
let client: QueryClient
let denied = false
let stale = false
let canGenerate = true
let complete = true
const job = () => ({
  id: 'translation',
  record_id: 'record',
  target: 'en',
  input_revision: 1,
  stale,
  status: 'succeeded',
  completed_chunks: 1,
  total_chunks: 1,
})
const show = (onSource = vi.fn()) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <UploadTranslationPanel
        viewerId="owner"
        recordId="record"
        onSource={onSource}
      />
    </QueryClientProvider>
  )
  return onSource
}
beforeEach(() => {
  denied = stale = false
  canGenerate = complete = true
  vi.mocked(fetchApi)
    .mockReset()
    .mockImplementation(async (path) => {
      if (denied) throw new ApiError(404, {})
      if (path.endsWith('upload-translations/'))
        return {
          can_generate: canGenerate,
          revision: 1,
          results: complete ? [job()] : [],
        }
      const next = path.includes('page=1')
      return {
        ...job(),
        next_page: next ? null : 1,
        results: [
          {
            segment_id: next ? 'last' : 'first',
            start_ms: 1200,
            speaker_name: 'Speaker',
            text: next ? 'Last original' : 'Original',
            translated_text: next ? 'Last translation' : 'Translated',
          },
        ],
      }
    })
})
afterEach(() => client?.clear())

it('reads aligned text, seeks the original clock, exports the selected translation and pages without retaining old text', async () => {
  const seek = show()
  await screen.findByText('Translated')
  expect(screen.getByText('original: Original')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'play' }))
  expect(seek).toHaveBeenCalledWith(1200)
  expect(screen.getAllByRole('link')[0]).toHaveAttribute(
    'href',
    expect.stringContaining('translation/export/?as=txt')
  )
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  await screen.findByText('Last translation')
  expect(screen.queryByText('Translated')).not.toBeInTheDocument()
})
it('marks a stale snapshot and disables its export and seek', async () => {
  stale = true
  show()
  await screen.findByText('Translated')
  expect(screen.getByText('stale')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'play' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'regenerate' })).toBeEnabled()
})
it('removes protected text when access revalidation fails and hides generation for readers', async () => {
  canGenerate = false
  show()
  await screen.findByText('Translated')
  expect(
    screen.queryByRole('button', { name: 'generate' })
  ).not.toBeInTheDocument()
  denied = true
  await act(() => client.invalidateQueries())
  await waitFor(() =>
    expect(screen.queryByText('Translated')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable')
})
it('keeps exactly the same paid intent after response loss', async () => {
  complete = false
  const read = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') throw new Error('lost response')
    return read(path, options)
  })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'generate' }))
  await screen.findByText('uncertain')
  fireEvent.click(screen.getByRole('button', { name: 'check' }))
  await waitFor(() =>
    expect(
      vi
        .mocked(fetchApi)
        .mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(2)
  )
  const calls = vi
    .mocked(fetchApi)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body)
  expect(screen.getByRole('combobox')).toBeDisabled()
})
it('changing language reads another product without issuing a paid request', async () => {
  show()
  await screen.findByText('Translated')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh' } })
  await screen.findByText('empty')
  expect(screen.queryByText('Translated')).not.toBeInTheDocument()
  expect(
    vi
      .mocked(fetchApi)
      .mock.calls.some(([, options]) => options?.method === 'POST')
  ).toBe(false)
})

it('rejects a response bound to another record', async () => {
  const read = vi.mocked(fetchApi).getMockImplementation()!
  vi.mocked(fetchApi).mockImplementation(async (path, options) => {
    const result = await read(path, options)
    return path.includes('?page=')
      ? { ...(result as object), record_id: 'another-record' }
      : result
  })
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
  expect(screen.queryByText('Translated')).not.toBeInTheDocument()
})
