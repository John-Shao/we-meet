import { fetchApi } from '@/api/fetchApi'
import { type ApiUser } from './ApiUser'

/**
 * Update the user's display name (用户名). Backend writes Keycloak `firstName`
 * via the Admin REST API and eagerly syncs the Django row, so the change
 * survives the next OIDC userinfo cycle. Empty is rejected server-side.
 */
export const updateNickname = (nickname: string): Promise<ApiUser> =>
  fetchApi(`/users/me/nickname/`, {
    method: 'PATCH',
    body: JSON.stringify({ nickname }),
  })

/**
 * Update the user's identity email (邮箱). Same Keycloak-Admin + local-sync
 * path as {@link updateNickname}; an empty string clears the email.
 */
export const updateEmail = (email: string): Promise<ApiUser> =>
  fetchApi(`/users/me/email/`, {
    method: 'PATCH',
    body: JSON.stringify({ email }),
  })
