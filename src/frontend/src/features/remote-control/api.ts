import { assertAuthSession, authenticatedFetch } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'

export type RemoteRequest = {
  id: string
  state: string
  stateVersion: number
  epoch: number
  deadline: number
  request: {
    controllerName: string
    controllerIdentity: string
    controllerSid: string
    targetIdentity: string
    targetSid: string
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Human-account API only; this is not the native authorization path. */
export async function remoteRequest<T>(
  roomId: string,
  action: 'capabilities' | 'requests' | 'session' | 'reject' | 'cancel' | 'end',
  options: { sessionId?: string; body?: Record<string, unknown> } = {}
): Promise<T> {
  const sessionAction = ['session', 'reject', 'cancel', 'end'].includes(action)
  if (
    !uuid.test(roomId) ||
    (sessionAction ? !uuid.test(options.sessionId ?? '') : !!options.sessionId)
  )
    throw new Error('invalid_remote_request')
  const suffix = sessionAction
    ? `${options.sessionId}/${action === 'session' ? '' : action + '/'}`
    : action + '/'
  const { response, snapshot } = await authenticatedFetch(
    `rooms/${roomId}/remote-control/${suffix}`,
    {
      method: options.body ? 'POST' : 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    }
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error('remote_response_invalid')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 262144) throw new Error('remote_response_oversize')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  assertAuthSession(snapshot)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const data = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  )
  if (!response.ok) throw new ApiError(response.status, data)
  return data as T
}
