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
const copyIntent = (value: IdentitySubmission): IdentitySubmission => ({
  ...value,
  user_ids: [...value.user_ids],
  speaker_ids: [...value.speaker_ids],
})
export const identityIntent = (client: IdentificationClient) => {
  const value = pending.get(key(client))
  return value && copyIntent(value)
}
export const rememberIdentityIntent = (
  client: IdentificationClient,
  value: IdentitySubmission
) => {
  const identifier = key(client)
  const previous = pending.get(identifier)
  if (
    previous &&
    (previous.request_key !== value.request_key ||
      previous.expected_revision !== value.expected_revision ||
      previous.organization_id !== value.organization_id ||
      previous.user_ids.join(',') !== value.user_ids.join(',') ||
      previous.speaker_ids.join(',') !== value.speaker_ids.join(','))
  )
    throw new Error('voiceprint_pending_request_exists')
  if (!pending.has(identifier) && pending.size >= 20)
    throw new Error('voiceprint_pending_requests_limit')
  pending.set(identifier, copyIntent(value))
}
export const acknowledgeIdentityIntent = (
  client: IdentificationClient,
  requestKey: string
) => {
  const identifier = key(client)
  if (pending.get(identifier)?.request_key === requestKey)
    pending.delete(identifier)
}
