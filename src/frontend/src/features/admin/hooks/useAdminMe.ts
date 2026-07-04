import { useQuery } from '@tanstack/react-query'

import { fetchAdminMe } from '../api/adminMe'

/** The caller's org + role, cached for the console session. */
export const useAdminMe = () =>
  useQuery({
    queryKey: ['admin', 'me'],
    queryFn: fetchAdminMe,
    staleTime: 60_000,
  })
