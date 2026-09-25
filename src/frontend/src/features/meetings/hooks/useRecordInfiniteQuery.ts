import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { ApiError } from '@/api/ApiError'
import { ViewState } from './useRecordViewState'

type Page = {
  results: unknown[]
  next_cursor?: string | null
  next_page?: number | null
}

function fatalRead(error: unknown) {
  return error instanceof ApiError
    ? [401, 403, 404, 409].includes(error.statusCode)
    : error instanceof Error && !(error instanceof TypeError)
}

/** Keep private pages only while mounted; remember only the amount read across tabs. */
export function useRecordInfiniteQuery<
  T extends Page,
  P extends string | number = string,
>({
  queryKey,
  queryFn,
  initialPageParam,
  enabled = true,
  refetchInterval = false,
}: {
  queryKey: QueryKey
  queryFn: (context: { signal: AbortSignal; pageParam: P }) => Promise<T>
  initialPageParam: P
  enabled?: boolean
  refetchInterval?: number | false
}) {
  const views = useContext(ViewState)
  const key = `pages:${JSON.stringify(queryKey)}`
  const restore = useRef({
    key,
    count: (views?.get(key) as number | undefined) ?? 1,
  })
  if (restore.current.key !== key)
    restore.current = {
      key,
      count: (views?.get(key) as number | undefined) ?? 1,
    }
  const query = useInfiniteQuery({
    queryKey: [...queryKey, 'infinite'],
    queryFn: ({ signal, pageParam }) =>
      queryFn({ signal, pageParam: pageParam as P }),
    initialPageParam,
    getNextPageParam: (last, _pages, _lastParam, params) => {
      const next = last.next_cursor ?? last.next_page
      return next !== null && next !== undefined && !params.includes(next as P)
        ? (next as P)
        : undefined
    },
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.error ? false : refetchInterval),
  })
  const fatal = fatalRead(query.error)
  const data = useMemo(() => {
    if (!query.data || fatal) return undefined
    const pages = query.data.pages
    const seen = new Set<unknown>()
    const results = pages
      .flatMap((page) => page.results)
      .filter((row) => {
        const item = row as { id?: string; segment_id?: string }
        const id = item.id ?? item.segment_id ?? row
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
    return {
      ...pages[0],
      results,
      next_cursor: pages.at(-1)?.next_cursor,
      next_page: pages.at(-1)?.next_page,
    } as T
  }, [query.data, fatal])
  const count = query.data?.pages.length ?? 0
  const { hasNextPage, isFetching, error, fetchNextPage } = query
  const loadMore = useCallback(() => {
    if (!isFetching && hasNextPage) void fetchNextPage({ cancelRefetch: false })
  }, [isFetching, hasNextPage, fetchNextPage])
  useEffect(() => {
    if (count) views?.set(key, Math.max(count, restore.current.count))
    if (
      enabled &&
      count &&
      count < restore.current.count &&
      hasNextPage &&
      !isFetching &&
      !error
    )
      void fetchNextPage({ cancelRefetch: false })
  }, [
    count,
    enabled,
    key,
    views,
    hasNextPage,
    isFetching,
    error,
    fetchNextPage,
  ])
  return {
    hasNextPage,
    isFetching,
    error,
    refetch: query.refetch,
    isFetchNextPageError: query.isFetchNextPageError,
    data,
    isError: query.isError && (!data || fatal),
    isSuccess: !!data,
    loadError: query.error,
    loadMore,
  }
}
