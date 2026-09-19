/**
 * Resumable chunked upload.
 *
 * The whole-file presigned PUT has one failure mode that matters at GB scale:
 * anything that breaks means starting over. This walks the file in parts against
 * object storage's multipart API instead, so a dropped connection costs the part
 * in flight rather than the whole import.
 *
 * Two things it deliberately does not own:
 *
 * - *What has already been uploaded.* That answer comes from the server, which
 *   asks storage, because a browser can be cleared mid-upload and a client that
 *   trusted its own notes would happily skip a part that never landed.
 * - *The upload id.* Same reason: it lives on the server, keyed by the intent.
 *   The browser keeps only the intent key, which is also what makes "resume
 *   after a reload" possible at all.
 */

/** Bytes of one part. Mirrors the server's plan; the server's value wins. */
export const DEFAULT_PART_SIZE = 64 * 1024 * 1024

/** Above this, a single PUT is no longer worth the all-or-nothing risk. */
export const CHUNKED_THRESHOLD = 100 * 1024 * 1024

export type PartPlan = {
  part_number: number
  url: string
  expected_bytes: number
}

/** An upload in progress, as the server describes it. */
export type SessionPlan = {
  session_id: string
  size: number
  part_size: number
  part_count: number
  uploaded: { part_number: number; etag: string; size: number }[]
  uploaded_bytes: number
  parts?: PartPlan[]
}

/**
 * `begin` can answer with a session *or* with a finished job: the same intent
 * may already have been completed, and replaying the job is better than opening
 * a second upload for bytes that are already stored.
 */
type BeginResponse = SessionPlan | { job: unknown }

const isPlan = (value: BeginResponse): value is SessionPlan =>
  'session_id' in value && typeof value.session_id === 'string'

export type Progress = (uploadedBytes: number, totalBytes: number) => void

/** Injected so the loop can be tested without a browser or a bucket. */
export type ChunkedDeps = {
  /** Talks to our own API. */
  request: <T>(path: string, init?: RequestInit) => Promise<T>
  /** PUTs bytes to storage, reporting progress and honouring an abort. */
  putPart: (
    url: string,
    body: Blob,
    onProgress: (sent: number) => void,
    signal: AbortSignal
  ) => Promise<{ ok: boolean; etag: string | null }>
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelled'
  }
}

/**
 * Key under which a session id is remembered for a given intent.
 *
 * `sessionStorage`, not `localStorage`: the server can already find the session
 * from the intent key, so this is a shortcut for the same tab, not a second
 * source of truth. A different tab or a new device simply calls `begin` again
 * and is handed the same plan.
 */
const rememberedKey = (intent: string) => `recording-upload-session:${intent}`

export function rememberSession(intent: string, sessionId: string) {
  try {
    sessionStorage.setItem(rememberedKey(intent), sessionId)
  } catch {
    // Private mode or a full quota: resuming is an optimisation, not a
    // requirement, and `begin` can always hand back the same session.
  }
}

export function forgetSession(intent: string) {
  try {
    sessionStorage.removeItem(rememberedKey(intent))
  } catch {
    // See above.
  }
}

export function rememberedSession(intent: string): string | null {
  try {
    return sessionStorage.getItem(rememberedKey(intent))
  } catch {
    return null
  }
}

/**
 * Upload one file in parts, resuming whatever storage already holds.
 *
 * Returns the completed job payload. Throws `UploadCancelled` if aborted — the
 * caller has to be able to tell a deliberate stop from a failure, because the
 * two want different UI.
 */
export async function uploadInParts(
  file: File,
  intent: string,
  declaration: {
    name: string
    content_type: string
    context: string
    hotwords: string
  },
  deps: ChunkedDeps,
  signal: AbortSignal,
  onProgress: Progress
): Promise<unknown> {
  const begin = (sessionId: string | null) =>
    deps.request<BeginResponse>(
      sessionId
        ? `recording-uploads/multipart/${encodeURIComponent(sessionId)}/`
        : 'recording-uploads/multipart/begin/',
      sessionId
        ? { method: 'GET', cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            body: JSON.stringify({ key: intent, size: file.size, ...declaration }),
          }
    )

  // A remembered session may have been aborted or completed elsewhere, so a
  // failed resume falls back to `begin`, which is idempotent on the intent.
  let state: BeginResponse | null = null
  const remembered = rememberedSession(intent)
  if (remembered) {
    try {
      state = await begin(remembered)
    } catch {
      state = null
      forgetSession(intent)
    }
  }
  if (!state) state = await begin(null)
  // A server that answered with a finished job has nothing left to upload.
  if (!isPlan(state)) return state.job
  rememberSession(intent, state.session_id)

  const total = state.size
  const partSize = state.part_size || DEFAULT_PART_SIZE
  const partCount = state.part_count
  onProgress(state.uploaded_bytes, total)

  // Server-known parts, so a resumed upload does not re-send what landed.
  const held = new Map(state.uploaded.map((part) => [part.part_number, part.etag]))
  const remaining: number[] = []
  for (let number = 1; number <= partCount; number += 1) {
    if (!held.has(number)) remaining.push(number)
  }

  // Sign in bounded batches: one request per part would not fit the endpoint's
  // request budget on a large file.
  const BATCH = 24
  for (let index = 0; index < remaining.length; index += BATCH) {
    if (signal.aborted) throw new UploadCancelled()
    const batch = remaining.slice(index, index + BATCH)
    const signed = await deps.request<SessionPlan>(
      `recording-uploads/multipart/${encodeURIComponent(state.session_id)}/parts/`,
      {
        method: 'POST',
        cache: 'no-store',
        body: JSON.stringify({ parts: batch }),
      }
    )
    let carried = state.uploaded_bytes
    for (const plan of signed.parts ?? []) {
      if (signal.aborted) throw new UploadCancelled()
      const start = (plan.part_number - 1) * partSize
      const end = Math.min(start + partSize, total)
      const blob = file.slice(start, end)
      const result = await deps.putPart(
        plan.url,
        blob,
        (sent) => onProgress(carried + sent, total),
        signal
      )
      if (signal.aborted) throw new UploadCancelled()
      if (!result.ok || !result.etag) {
        // A part that did not land is not recorded, so the next attempt resumes
        // from here instead of pretending it succeeded.
        throw new Error(`part ${plan.part_number} failed`)
      }
      held.set(plan.part_number, result.etag)
      carried += end - start
      onProgress(carried, total)
    }
  }

  if (signal.aborted) throw new UploadCancelled()
  const parts = [...held.entries()]
    .sort(([a], [b]) => a - b)
    .map(([part_number, etag]) => ({ part_number, etag }))
  const job = await deps.request<unknown>(
    `recording-uploads/multipart/${encodeURIComponent(state.session_id)}/`,
    {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ parts }),
    }
  )
  forgetSession(intent)
  return job
}

/**
 * Abort a session on the server as well as locally.
 *
 * Worth the round trip: storage bills the parts of an incomplete upload, so a
 * cancelled import that is only forgotten keeps costing money.
 */
export async function abortSession(
  sessionId: string,
  request: <T>(path: string, init?: RequestInit) => Promise<T>
): Promise<void> {
  await request(`recording-uploads/multipart/${encodeURIComponent(sessionId)}/`, {
    method: 'DELETE',
    cache: 'no-store',
    redirect: 'error',
  })
}

/**
 * PUT one part with real byte progress and a working cancel.
 *
 * `fetch` can do neither: it reports no upload progress, and aborting it is only
 * observable through a rejection. `XMLHttpRequest` is the older API that can,
 * which is the whole reason this part is not a `fetch`.
 */
export function putPartWithProgress(
  url: string,
  body: Blob,
  onProgress: (sent: number) => void,
  signal: AbortSignal
): Promise<{ ok: boolean; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const stop = () => xhr.abort()
    signal.addEventListener('abort', stop, { once: true })
    const done = () => signal.removeEventListener('abort', stop)
    xhr.open('PUT', url)
    // The signed URL is the authorization; sending our session to a storage host
    // would leak an app credential for nothing. The signature covers the content
    // type, so that one header must be present and unchanged.
    xhr.withCredentials = false
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }
    xhr.onload = () => {
      done()
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        // Storage reports the ETag the completion call needs. A bucket that does
        // not expose this header to the browser cannot complete an upload.
        etag: xhr.getResponseHeader('ETag')?.replace(/"/g, '') ?? null,
      })
    }
    xhr.onerror = () => {
      done()
      reject(new Error('part upload failed'))
    }
    xhr.onabort = () => {
      done()
      reject(new UploadCancelled())
    }
    xhr.send(body)
  })
}
