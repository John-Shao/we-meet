import {
  MutationCache,
  QueryCache,
  QueryClient,
} from '@tanstack/react-query'

import { ApiError } from './ApiError'
import { keys } from './queryKeys'

/**
 * Auth state is cached indefinitely by useUser. When a session expires while
 * an authenticated page stays open, an unrelated query/mutation can therefore
 * be the first request to discover it. Revalidate the shared user query so the
 * existing RequireAuth + silent-login flow can take over instead of leaving
 * the page looking logged in and showing a domain-specific generic error.
 */
const revalidateUserOnUnauthorized = (error: Error) => {
  if (error instanceof ApiError && error.statusCode === 401) {
    void queryClient.invalidateQueries({ queryKey: [keys.user] })
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: revalidateUserOnUnauthorized }),
  mutationCache: new MutationCache({ onError: revalidateUserOnUnauthorized }),
})
