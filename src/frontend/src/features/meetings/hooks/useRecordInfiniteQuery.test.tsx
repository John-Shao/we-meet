import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/ApiError'
import { useRecordInfiniteQuery } from './useRecordInfiniteQuery'
import { RecordLoadMore } from '../components/RecordLoadMore'
import { ViewState } from './useRecordViewState'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
type Page = {
  results: { id: string; text: string }[]
  next_cursor: string | null
}
afterEach(() => vi.unstubAllGlobals())
function show(read: (cursor: string) => Promise<Page>) {
  const client = new QueryClient()
  function Reader({ filter = '' }: { filter?: string }) {
    const query = useRecordInfiniteQuery({
      queryKey: ['reader', filter],
      initialPageParam: '',
      queryFn: ({ pageParam }) => read(pageParam),
    })
    return (
      <>
        <button onClick={() => void query.refetch()}>refresh</button>
        {query.data?.results.map((row) => (
          <p key={row.id}>{row.text}</p>
        ))}
        {query.isError ? (
          <p role="alert">unavailable</p>
        ) : (
          <RecordLoadMore query={query} />
        )}
      </>
    )
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Reader />
    </QueryClientProvider>
  )
  return {
    ...view,
    filter: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Reader filter="new" />
        </QueryClientProvider>
      ),
  }
}
const page = (second = false): Page => ({
  results: [
    { id: second ? 'b' : 'a', text: second ? 'Later text' : 'Earlier text' },
  ],
  next_cursor: second ? null : 'next',
})

it('restores read depth with fresh reads after a tab unmounts, without saving text', async () => {
  const views = new Map<string, unknown>()
  const client = new QueryClient()
  const read = vi.fn(async (cursor: string) => page(!!cursor))
  function Reader() {
    const query = useRecordInfiniteQuery({
      queryKey: ['restore'],
      initialPageParam: '',
      queryFn: ({ pageParam }) => read(pageParam),
    })
    return (
      <>
        {query.data?.results.map((row) => (
          <p key={row.id}>{row.text}</p>
        ))}
        <RecordLoadMore query={query} />
      </>
    )
  }
  const wrap = (shown: boolean) => (
    <QueryClientProvider client={client}>
      <ViewState.Provider value={views}>
        {shown && <Reader />}
      </ViewState.Provider>
    </QueryClientProvider>
  )
  const view = render(wrap(true))
  await screen.findByText('Earlier text')
  fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
  await screen.findByText('Later text')
  view.rerender(wrap(false))
  client.removeQueries()
  expect([...views.values()]).toEqual([2])
  view.rerender(wrap(true))
  await screen.findByText('Later text')
  expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([
    '',
    'next',
    '',
    'next',
  ])
})

it('appends once when the sentinel intersects and keeps earlier text', async () => {
  let intersect: IntersectionObserverCallback = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback
      }
      observe() {}
      disconnect() {}
    }
  )
  const read = vi.fn(async (cursor: string) => page(!!cursor))
  show(read)
  await screen.findByText('Earlier text')
  act(() => {
    intersect(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver
    )
    intersect(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver
    )
  })
  await screen.findByText('Later text')
  expect(screen.getByText('Earlier text')).toBeInTheDocument()
  expect(read.mock.calls.map(([cursor]) => cursor)).toEqual(['', 'next'])
  expect(screen.getByText('continuous.end')).toBeInTheDocument()
})

it('keeps loaded text after a failed next page and retries the same cursor', async () => {
  let failed = true
  const read = vi.fn(async (cursor: string) => {
    if (cursor && failed) throw new ApiError(503, {})
    return page(!!cursor)
  })
  show(read)
  await screen.findByText('Earlier text')
  fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
  await screen.findByRole('button', { name: 'continuous.retry' })
  expect(screen.getByText('Earlier text')).toBeInTheDocument()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'continuous.retry' }))
  await screen.findByText('Later text')
  expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([
    '',
    'next',
    'next',
  ])
})

it('revalidates all loaded pages on refresh without clearing visible text', async () => {
  let release: (() => void) | undefined
  let refreshing = false
  const read = vi.fn(async (cursor: string) => {
    if (refreshing && !cursor)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return page(!!cursor)
  })
  show(read)
  await screen.findByText('Earlier text')
  fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
  await screen.findByText('Later text')
  refreshing = true
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  expect(screen.getByText('Earlier text')).toBeInTheDocument()
  expect(screen.getByText('Later text')).toBeInTheDocument()
  await act(async () => release?.())
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4))
})

it('clears every loaded page on revoked permission and resets pages on a new search', async () => {
  let denied = false
  const view = show(async (cursor) => {
    if (denied) throw new ApiError(403, {})
    return page(!!cursor)
  })
  await screen.findByText('Earlier text')
  fireEvent.click(screen.getByRole('button', { name: 'continuous.more' }))
  await screen.findByText('Later text')
  view.filter()
  await screen.findByText('Earlier text')
  expect(screen.queryByText('Later text')).not.toBeInTheDocument()
  denied = true
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('Earlier text')).not.toBeInTheDocument()
})
