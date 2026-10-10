import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import type {
  IdentificationClient,
  IdentitySubmission,
} from './identificationApi'

// Unacknowledged commands survive closing a panel, only in this tab's memory.
// No names, audio, templates, credentials or browser storage are kept here.
const pending = new Map<string, IdentitySubmission>()
let session: string | null | undefined
const key = (client: IdentificationClient) => {
  const current = getAuthSnapshot().session
  if (session !== current) {
    pending.clear()
    session = current
  }
  if (!sameAuthSession(client.auth)) throw new Error('authentication_changed')
  return `${client.ownerId}:${client.recordId}`
}
export const clearIdentityIntents = () => {
  pending.clear()
  session = undefined
}
export const identityIntent = (client: IdentificationClient) =>
  pending.get(key(client))
export const rememberIdentityIntent = (
  client: IdentificationClient,
  value: IdentitySubmission
) => {
  const identifier = key(client)
  if (!pending.has(identifier) && pending.size >= 20)
    throw new Error('voiceprint_pending_requests_limit')
  pending.set(identifier, {
    ...value,
    user_ids: [...value.user_ids],
    speaker_ids: [...value.speaker_ids],
  })
}
export const acknowledgeIdentityIntent = (
  client: IdentificationClient,
  requestKey: string
) => {
  const identifier = key(client)
  if (pending.get(identifier)?.request_key === requestKey)
    pending.delete(identifier)
}
