import { ApiError } from './ApiError'
import { apiUrl } from './apiUrl'
import { attemptSilentRefresh } from './fetchApi'
import { clearTokens, getAccessToken } from '@/features/auth/utils/tokenStorage'

/**
 * SSE event frame envelope.
 *
 * Both Room AI (`/rooms/{id}/ask-ai-stream/`) and Personal AI
 * (`/users/me/ai/ask-stream/`) use the same wire shape:
 *
 * - `meta`  — sent once, before any `delta`. Carries citation metadata
 *             so the UI can render chips while waiting for the first token.
 * - `delta` — one per text chunk; concatenate to build the final answer.
 * - `done`  — terminator. Stream is closed shortly after.
 * - `error` — emitted instead of `done` when the service blew up
 *             mid-stream. UI should surface this as a toast.
 *
 * The two endpoints attach different fields to `meta` (Room: `transcripts_used`;
 * Personal: `rooms_referenced` + `chunks_used`). We model that with a
 * discriminated-union–compatible loose dict so each consumer can narrow
 * via `ev.type === 'meta'` and read the fields it cares about.
 */
export type SSEEvent =
  | ({ type: 'meta' } & Record<string, unknown>)
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

const CSRF_COOKIE = 'csrftoken='

const getCsrfToken = (): string | undefined =>
  document.cookie
    .split(';')
    .filter((c) => c.trim().startsWith(CSRF_COOKIE))
    .map((c) => c.split('=')[1])
    .pop()

interface SseStreamOptions {
  /** Body to POST. Will be JSON.stringify-ed. */
  body: unknown
  /** Extra headers to attach (e.g. Authorization: Bearer for Room AI). */
  headers?: Record<string, string>
  /** Allow aborting the in-flight stream (e.g. on drawer close). */
  signal?: AbortSignal
}

/**
 * POST to a backend SSE endpoint and yield each event as it arrives.
 *
 * Doesn't use the native `EventSource` because that's GET-only and we
 * need to attach a sizeable JSON body. We hand-roll the wire parser —
 * SSE frames are `data: <json>\n\n` so the protocol is barely an
 * inconvenience.
 *
 * Auth mirrors `fetchApi`: the OIDC/OTP bearer from `getAccessToken()` is
 * attached automatically and a 401 triggers one silent refresh + retry.
 * A caller-supplied `Authorization` header (Room AI's LiveKit token) takes
 * precedence and disables the bearer auto-attach/refresh.
 *
 * Throws `ApiError` synchronously when the response status isn't 2xx
 * (e.g. 400 on bad input, 401/403 on auth, 429 on throttle). Mid-stream
 * faults arrive as in-band `error` events instead.
 */
export async function* sseStream(
  path: string,
  { body, headers, signal }: SseStreamOptions
): AsyncIterable<SSEEvent> {
  const csrf = getCsrfToken()
  const target = apiUrl(path)
  // The caller (Room AI) may pass its own `Authorization` header; that wins
  // over the session bearer and opts out of the bearer refresh dance.
  const callerHasAuth = Object.keys(headers || {}).some(
    (k) => k.toLowerCase() === 'authorization'
  )
  const initialBearer = callerHasAuth ? null : getAccessToken()

  const doFetch = (bearer: string | null) =>
    fetch(target, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(headers || {}),
      },
      body: JSON.stringify(body),
    })

  let resp = await doFetch(initialBearer)

  // Bearer 401 → one silent refresh + retry, same contract as `fetchApi`.
  if (resp.status === 401 && initialBearer) {
    const newAccess = await attemptSilentRefresh()
    if (newAccess) resp = await doFetch(newAccess)
    if (resp.status === 401) clearTokens()
  }

  if (!resp.ok) {
    // Try to surface a useful detail — the SSE 400/403/429 paths return
    // JSON or text rather than an event stream.
    let payload: unknown = undefined
    try {
      payload = await resp.json()
    } catch {
      try {
        payload = await resp.text()
      } catch {
        payload = undefined
      }
    }
    throw new ApiError(resp.status, payload)
  }

  const reader = resp.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder('utf-8')
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE frame delimiter is a blank line (two consecutive newlines).
    while (true) {
      const idx = buf.indexOf('\n\n')
      if (idx < 0) break
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      // Each frame may have multiple lines; we only care about ``data:``.
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        try {
          yield JSON.parse(raw) as SSEEvent
        } catch {
          // Skip malformed frames silently — keepalive / future event
          // shapes shouldn't crash the consumer.
        }
      }
    }
  }
}
