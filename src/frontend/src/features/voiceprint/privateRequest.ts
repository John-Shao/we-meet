import { assertAuthSession } from '@/api/fetchApi'
import type { AuthSnapshot } from '@/features/auth/utils/tokenStorage'

/** A bounded private operation stays in its original login even if fetch ignores abort. */
export async function privateVoiceprintRequest<T>(
  auth: AuthSnapshot,
  action: (signal: AbortSignal) => Promise<T>,
  external?: AbortSignal | null
): Promise<T> {
  assertAuthSession(auth)
  external?.throwIfAborted()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      cancel = () => {
        controller.abort()
        reject(new Error('canceled'))
      }
      external?.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('voiceprint_request_timeout'))
      }, 15000)
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          assertAuthSession(auth)
          return action(controller.signal)
        })
        .then((value) => {
          try {
            assertAuthSession(auth)
            resolve(value)
          } catch (error) {
            reject(error)
          }
        }, reject)
    })
  } finally {
    clearTimeout(timer)
    if (cancel) external?.removeEventListener('abort', cancel)
  }
}
