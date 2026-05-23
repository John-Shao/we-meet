import { useQuery } from '@tanstack/react-query'
import { keys } from '@/api/queryKeys'
import { fetchUser } from './fetchUser'
import { type ApiUser } from './ApiUser'
import { useEffect, useMemo } from 'react'
import {
  startAnalyticsSession,
  terminateAnalyticsSession,
} from '@/features/analytics/hooks/useAnalytics'
import {
  initializeSupportSession,
  terminateSupportSession,
} from '@/features/support/hooks/useSupport'
import { logoutUrl } from '../utils/logoutUrl'
import { clearTokens } from '../utils/tokenStorage'
import { useConfig } from '@/api/useConfig'

/**
 * returns info about currently logged-in user
 *
 * `isLoggedIn` is undefined while query is loading and true/false when it's done
 */
export const useUser = (
  opts: {
    fetchUserOptions?: Parameters<typeof fetchUser>[0]
  } = {}
) => {
  const { data, isLoading: isConfigLoading } = useConfig()

  const options = useMemo(() => {
    if (isConfigLoading) return
    if (data?.is_silent_login_enabled !== true) {
      return {
        ...opts,
        attemptSilent: false,
      }
    }
    return opts.fetchUserOptions
  }, [data, opts, isConfigLoading])

  const query = useQuery({
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [keys.user],
    queryFn: () => fetchUser(options),
    staleTime: Infinity,
    enabled: !isConfigLoading,
  })

  useEffect(() => {
    if (query?.data) {
      startAnalyticsSession(query.data)
      initializeSupportSession(query.data)
    }
  }, [query.data])

  const logout = () => {
    terminateAnalyticsSession()
    terminateSupportSession()
    // Drop the bearer first — if the user signed in via the mobile OTP flow
    // there's no Django session for /logout to clear, but the next page load
    // would still see the cached token and re-authenticate as them.
    clearTokens()
    window.location.href = logoutUrl()
  }

  const isLoggedIn =
    query.status === 'success' ? query.data !== false : undefined
  const isLoggedOut = isLoggedIn === false

  return {
    refetch: query.refetch,
    user: isLoggedOut ? undefined : (query.data as ApiUser | undefined),
    isLoggedIn,
    isLoading: query.isLoading,
    logout,
  }
}
