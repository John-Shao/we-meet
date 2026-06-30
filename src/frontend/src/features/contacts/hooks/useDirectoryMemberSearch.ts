import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { fetchDirectoryMembers } from '../api/fetchDirectoryMembers'

/**
 * Debounced org-directory member search shared by the contact pickers.
 *
 * Returns the live `query`/`setQuery` for the search box, the `selectable`
 * members (the caller themselves — `is_self` — is always filtered out), and
 * `isFetching`. The search is debounced and uses `keepPreviousData` so the list
 * doesn't flicker to empty between keystrokes.
 */
export const useDirectoryMemberSearch = (debounceMs = 250) => {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), debounceMs)
    return () => clearTimeout(id)
  }, [query, debounceMs])

  const { data: members = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', debouncedQuery],
    queryFn: () => fetchDirectoryMembers(debouncedQuery),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  const selectable = members.filter((m) => !m.is_self)
  return { query, setQuery, selectable, isFetching }
}
