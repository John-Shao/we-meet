import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'

import { fetchDirectoryMembersPage } from '../api/fetchDirectoryMembers'

/**
 * Debounced org-directory member search shared by the contact pickers.
 *
 * Pages rather than taking the first 100 rows: this hook backs group creation,
 * starred contacts and calendar invites, and a truncated list there shows up as
 * "I can't find my colleague" with nothing on screen to suggest the list simply
 * stopped. `fetchNextPage` / `hasNextPage` let each picker load the rest.
 *
 * Returns the live `query`/`setQuery` for the search box and the `selectable`
 * members (the caller themselves — `is_self` — is always filtered out).
 * `keepPreviousData` stops the list flickering to empty between keystrokes.
 */
export const useDirectoryMemberSearch = (debounceMs = 250) => {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), debounceMs)
    return () => clearTimeout(id)
  }, [query, debounceMs])

  const { data, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['directory', 'members', 'infinite', debouncedQuery],
      queryFn: ({ pageParam }) =>
        fetchDirectoryMembersPage(debouncedQuery, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.next ?? undefined,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    })

  const selectable = useMemo(
    () =>
      (data?.pages ?? []).flatMap((page) =>
        page.results.filter((m) => !m.is_self),
      ),
    [data],
  )

  return {
    query,
    setQuery,
    selectable,
    isFetching,
    fetchNextPage,
    hasNextPage: hasNextPage ?? false,
    isFetchingNextPage,
  }
}
