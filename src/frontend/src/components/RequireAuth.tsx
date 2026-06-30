import { type ReactNode } from 'react'
import { Redirect } from 'wouter'

import { useUser } from '@/features/auth'

/**
 * Route guard for logged-in-only workspace pages. While auth is still resolving
 * it renders nothing (avoids a wrong-way flash); once resolved, anonymous users
 * are sent to "/" (the login landing) instead of seeing an inline "please sign
 * in" message. Public pages (room, /meeting home) are NOT wrapped.
 */
export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { isLoggedIn, user } = useUser()
  if (isLoggedIn === undefined) return null
  if (!isLoggedIn || !user) return <Redirect to="/" replace />
  return <>{children}</>
}
