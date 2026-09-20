import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  abortSession,
  forgetSession,
  rememberedSession,
  rememberSession,
  UploadCancelled,
  uploadInParts,
  type ChunkedDeps,
  type SessionPlan,
} from './chunkedUpload'

/**
 * The chunk loop, without a browser or a bucket.
 *
 * The behaviours worth pinning are the ones a happy-path test would miss: that a
 * resumed upload does not re-send bytes storage already holds, that a part which
 * failed is not recorded as done, and that a cancel is distinguishable from a
 * failure.
 */

const PART = 64 * 1024 * 1024
const SIZE = 2 * PART

const plan = (overrides: Partial<SessionPlan> = {}): SessionPlan => ({
  session_id: 'session-1',
  size: SIZE,
  part_size: PART,
  part_count: 2,
  uploaded: [],
  uploaded_bytes: 0,
  ...overrides,
})

function harness(
  script: {
    /** What a resume (GET) answers with. */
    resume?: SessionPlan
    /** What `begin` answers with; `{ job }` models an already-completed intent. */
    begin?: SessionPlan | { job: unknown }
  } = {}
) {
  const calls: { path: string; init?: RequestInit }[] = []
  const puts: { url: string; size: number }[] = []
  // A plain function rather than `vi.fn`: the request seam is generic, and a
  // mocked generic loses its type parameter.
  const respond = async (
    path: string,
    init?: RequestInit
  ): Promise<unknown> => {
    calls.push({ path, init })
    if (path.endsWith('/begin/')) return script.begin ?? plan()
    if (path.endsWith('/parts/')) {
      const numbers = JSON.parse(String(init?.body)).parts as number[]
      return {
        ...plan(),
        parts: numbers.map((part_number) => ({
          part_number,
          url: `https://bucket.example/part/${part_number}`,
          expected_bytes: PART,
        })),
      }
    }
    if (path.includes('/multipart/') && init?.method === 'GET') {
      return script.resume ?? plan()
    }
    if (init?.method === 'DELETE') return undefined
    // Completion.
    return { record_id: 'record', status: 'queued' }
  }
  const deps: ChunkedDeps = {
    request: respond as ChunkedDeps['request'],
    putPart: vi.fn(async (url, body) => {
      puts.push({ url, size: body.size })
      return { ok: true, etag: `etag-${url.split('/').pop()}` }
    }),
  }
  return { deps, calls, puts }
}

const declaration = {
  name: 'Long.wav',
  content_type: 'audio/wav',
  context: '',
  hotwords: '',
}

it('resumes an assembled object without signing or uploading another part', async () => {
  const { deps, calls, puts } = harness({
    begin: plan({ completion_pending: true, uploaded_bytes: SIZE }),
  })
  const result = await uploadInParts(
    sized(SIZE),
    'assembled',
    declaration,
    deps,
    new AbortController().signal,
    () => {}
  )
  expect(result).toEqual({ record_id: 'record', status: 'queued' })
  expect(puts).toHaveLength(0)
  expect(calls).toHaveLength(2)
  expect(JSON.parse(String(calls[1].init?.body))).toEqual({ parts: [] })
})

it('keeps progress increasing across signing batches', async () => {
  const size = PART * 26
  const { deps } = harness({ begin: plan({ size, part_count: 26 }) })
  const progress: number[] = []
  await uploadInParts(
    sized(size),
    'large',
    declaration,
    deps,
    new AbortController().signal,
    (sent) => progress.push(sent)
  )
  expect(progress.at(-1)).toBe(size)
  expect(
    progress.every((value, index) => !index || value >= progress[index - 1])
  ).toBe(true)
})

// A File's size is fixed by its content, so the declared size is overridden
// rather than allocating a multi-megabyte buffer in a unit test.
const sized = (size: number) => {
  const blob = new File([new Uint8Array(1)], 'Long.wav')
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

beforeEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('uploadInParts', () => {
  it('uploads every part when nothing has landed yet', async () => {
    const { deps, puts } = harness()
    const progress: number[] = []
    const job = await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      (sent) => progress.push(sent)
    )
    expect(job).toEqual({ record_id: 'record', status: 'queued' })
    expect(puts.map((p) => p.url)).toEqual([
      'https://bucket.example/part/1',
      'https://bucket.example/part/2',
    ])
    // Progress is reported per part and ends at the whole size.
    expect(progress.at(0)).toBe(0)
    expect(progress.at(-1)).toBe(SIZE)
  })

  it('resumes without re-sending what storage already holds', async () => {
    // This is the entire point of the feature: the bytes that landed stay landed.
    const { deps, puts } = harness({
      resume: plan({
        uploaded: [{ part_number: 1, etag: 'etag-1', size: PART }],
        uploaded_bytes: PART,
      }),
    })
    rememberSession('intent-1', 'session-1')
    const progress: number[] = []
    await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      (sent) => progress.push(sent)
    )
    expect(puts.map((p) => p.url)).toEqual(['https://bucket.example/part/2'])
    // The already-stored part still counts toward the reported progress.
    expect(progress.at(-1)).toBe(SIZE)
  })

  it('completes with the etags, including parts uploaded before the reload', async () => {
    const { deps, calls } = harness()
    deps.request = (async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      if (path.includes('/multipart/') && init?.method === 'GET') {
        return plan({
          uploaded: [{ part_number: 1, etag: 'etag-earlier', size: PART }],
          uploaded_bytes: PART,
        })
      }
      if (path.endsWith('/parts/')) {
        const numbers = JSON.parse(String(init?.body)).parts as number[]
        return {
          ...plan(),
          parts: numbers.map((part_number) => ({
            part_number,
            url: `https://bucket.example/part/${part_number}`,
            expected_bytes: PART,
          })),
        }
      }
      return { record_id: 'record', status: 'queued' }
    }) as ChunkedDeps['request']
    rememberSession('intent-1', 'session-1')
    await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      () => {}
    )
    const complete = calls.at(-1)!
    expect(complete.init?.method).toBe('POST')
    const parts = JSON.parse(String(complete.init?.body)).parts
    expect(parts).toEqual([
      { part_number: 1, etag: 'etag-earlier' },
      { part_number: 2, etag: 'etag-2' },
    ])
  })

  it('falls back to begin when the remembered session is gone', async () => {
    const { deps, puts, calls } = harness()
    // A stale id from a previous attempt must not strand the upload.
    rememberSession('intent-1', 'session-1')
    const inner = deps.request
    let stale = true
    deps.request = (async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      // Only the resume fails: a real 410 is about the id, not the API.
      if (stale && path.includes('/multipart/session-1/')) {
        stale = false
        throw new Error('410')
      }
      return inner(path, init)
    }) as ChunkedDeps['request']
    const job = await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      () => {}
    )
    expect(job).toEqual({ record_id: 'record', status: 'queued' })
    // The stale session was tried, dropped, and begin took over.
    expect(calls[0].path).toContain('/multipart/session-1/')
    expect(calls.some((call) => call.path.endsWith('/begin/'))).toBe(true)
    expect(puts).toHaveLength(2)
  })

  it('does not record a part that failed, so a retry resumes from there', async () => {
    const { deps, calls } = harness()
    deps.putPart = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, etag: null })
      .mockResolvedValue({ ok: true, etag: 'etag-x' })
    await expect(
      uploadInParts(
        sized(SIZE),
        'intent-1',
        declaration,
        deps,
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow('part 1 failed')
    // Nothing was completed, so the next attempt starts from the failed part
    // rather than believing it is done.
    expect(
      calls.some(
        (c) =>
          c.path.endsWith('/multipart/session-1/') && c.init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('aborts as a cancel, not a failure', async () => {
    // The two want different UI, so they must be distinguishable.
    const { deps } = harness()
    const controller = new AbortController()
    deps.putPart = vi.fn(async () => {
      controller.abort()
      return { ok: true, etag: 'etag-1' }
    })
    await expect(
      uploadInParts(
        sized(SIZE),
        'intent-1',
        declaration,
        deps,
        controller.signal,
        () => {}
      )
    ).rejects.toBeInstanceOf(UploadCancelled)
  })

  it('returns the finished job when the intent was already completed', async () => {
    // `begin` is idempotent, so a repeated intent answers with the job rather
    // than opening a second upload for bytes that are already stored.
    const { deps, puts } = harness()
    deps.request = (async () => ({
      job: { record_id: 'existing', status: 'queued' },
    })) as ChunkedDeps['request']
    const job = await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      () => {}
    )
    expect(job).toEqual({ record_id: 'existing', status: 'queued' })
    expect(puts).toEqual([])
  })

  it('batches signing so a large file does not need one request per part', async () => {
    const partSize = 1024
    const count = 60
    const { deps, calls, puts } = harness()
    // A small part size keeps this fast while still forcing several batches.
    deps.request = (async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      if (path.endsWith('/begin/')) {
        return {
          ...plan(),
          size: partSize * count,
          part_size: partSize,
          part_count: count,
        }
      }
      if (path.endsWith('/parts/')) {
        const numbers = JSON.parse(String(init?.body)).parts as number[]
        return {
          ...plan(),
          parts: numbers.map((part_number) => ({
            part_number,
            url: `https://bucket.example/part/${part_number}`,
            expected_bytes: partSize,
          })),
        }
      }
      return { record_id: 'record', status: 'queued' }
    }) as ChunkedDeps['request']
    await uploadInParts(
      sized(partSize * count),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      () => {}
    )
    const signing = calls.filter((call) => call.path.endsWith('/parts/')).length
    // Every part still goes up, but signing is batched: one request per part
    // would not fit the endpoint's request budget on a real 6 GiB file.
    expect(puts).toHaveLength(count)
    expect(signing).toBeGreaterThan(0)
    expect(signing).toBeLessThan(count)
  })

  it('forgets the session once the upload is adopted', async () => {
    const { deps } = harness()
    await uploadInParts(
      sized(SIZE),
      'intent-1',
      declaration,
      deps,
      new AbortController().signal,
      () => {}
    )
    expect(rememberedSession('intent-1')).toBeNull()
  })

  it('survives a storage that refuses to remember the session', async () => {
    // Private mode throws on sessionStorage; resuming is an optimisation, so the
    // upload must still work.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { deps } = harness()
    await expect(
      uploadInParts(
        sized(SIZE),
        'intent-1',
        declaration,
        deps,
        new AbortController().signal,
        () => {}
      )
    ).resolves.toEqual({ record_id: 'record', status: 'queued' })
  })
})

describe('abortSession', () => {
  it('tells the server, because incomplete parts are billed', async () => {
    const request = vi.fn(async () => undefined)
    await abortSession(
      'session-1',
      request as unknown as ChunkedDeps['request']
    )
    expect(request).toHaveBeenCalledWith(
      'recording-uploads/multipart/session-1/',
      expect.objectContaining({ method: 'DELETE' })
    )
  })
})

describe('session memory', () => {
  it('round-trips and forgets', () => {
    rememberSession('intent-1', 'session-1')
    expect(rememberedSession('intent-1')).toBe('session-1')
    forgetSession('intent-1')
    expect(rememberedSession('intent-1')).toBeNull()
  })

  it('reports nothing rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(rememberedSession('intent-1')).toBeNull()
  })
})
