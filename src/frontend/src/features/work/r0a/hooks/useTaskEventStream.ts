import { useEffect, useRef, useState } from 'react'

import { openWorkEventStream, WorkApiError } from '../api/client'
import type { WorkTaskEvent } from '../api/types'

export type SseFrame = {
  id?: string
  event?: string
  data?: string
}

export const parseSseFrames = (
  input: string
): { frames: SseFrame[]; rest: string } => {
  const normalized = input.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const frames: SseFrame[] = []
  for (const block of blocks) {
    const frame: SseFrame = {}
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('retry:')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'id') frame.id = value
      else if (field === 'event') frame.event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) frame.data = data.join('\n')
    if (frame.id || frame.event || frame.data) frames.push(frame)
  }
  return { frames, rest }
}

export type StreamStatus =
  | 'closed'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'error'

// D5: this is a bounded live timeline, not a durable event log or artifact buffer.
export const MAX_LIVE_EVENTS = 500
export const MAX_SEEN_EVENTS = 1_000
export const MAX_SSE_FRAME_CHARS = 64 * 1024
const EMPTY_EVENTS: WorkTaskEvent[] = []

export const useTaskEventStream = (
  taskId: string | undefined,
  enabled: boolean,
  onResync: () => Promise<string | null>,
  initialCursor?: string | null
) => {
  const [eventState, setEventState] = useState<{
    taskId?: string
    events: WorkTaskEvent[]
  }>({ taskId, events: [] })
  const [status, setStatus] = useState<StreamStatus>('closed')
  const [error, setError] = useState<string | null>(null)
  const initialCursorRef = useRef(initialCursor)
  const onResyncRef = useRef(onResync)
  onResyncRef.current = onResync
  initialCursorRef.current = initialCursor

  useEffect(() => {
    setEventState({ taskId, events: [] })
    setError(null)
  }, [taskId])

  useEffect(() => {
    if (!taskId || !enabled) {
      setStatus('closed')
      return
    }
    let stopped = false
    let controller: AbortController | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: number | undefined
    let attempt = 0
    // Capture this task's snapshot once. Unrelated query refreshes must not skip
    // the interval between the last consumed event and the next connection.
    let cursor = initialCursorRef.current ?? undefined
    let needsResync = !cursor
    const refreshSnapshot = onResyncRef.current
    const seen = new Set<string>()

    const requireResync = () => {
      needsResync = true
      seen.clear()
      setEventState({ taskId, events: [] })
    }

    const resync = async () => {
      setStatus('reconnecting')
      const freshCursor = await refreshSnapshot()
      if (stopped) return
      // Never fall back to the 409 header or an unanchored stream: neither
      // proves which events were included in the snapshot now on screen.
      if (!freshCursor) throw new Error('task snapshot has no event cursor')
      cursor = freshCursor
      seen.clear()
      needsResync = false
      setError(null)
    }

    const schedule = () => {
      if (stopped) return
      setStatus('reconnecting')
      const delay = Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500
      attempt = Math.min(attempt + 1, 5)
      timer = window.setTimeout(connect, delay)
    }

    const connect = async () => {
      if (stopped) return
      controller = new AbortController()
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      try {
        if (needsResync) {
          await resync()
          if (stopped) return
        }
        const response = await openWorkEventStream(
          taskId,
          controller.signal,
          cursor
        )
        if (stopped) {
          void response.body?.cancel().catch(() => {})
          return
        }
        if (!response.ok) {
          if (response.status === 409) {
            throw new WorkApiError(409, { code: 'resync_required' })
          }
          let code = ''
          try {
            const body = (await response.json()) as { code?: string }
            code = body.code ?? ''
          } catch {
            /* gateway error */
          }
          if (stopped) return
          if ([401, 403, 404].includes(response.status)) {
            setStatus('error')
            setError(code || `HTTP ${response.status}`)
            return
          }
          throw new Error(code || `HTTP ${response.status}`)
        }
        if (!response.body) throw new Error('event stream has no body')
        setStatus('open')
        setError(null)
        attempt = 0
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!stopped) {
          const { done, value } = await reader.read()
          if (stopped) return
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          const incoming: WorkTaskEvent[] = []
          // Bound parsing even when the transport coalesces many frames.
          for (let offset = 0; offset < chunk.length; offset += 8_192) {
            buffer += chunk.slice(offset, offset + 8_192)
            const parsed = parseSseFrames(buffer)
            buffer = parsed.rest
            if (
              buffer.length > MAX_SSE_FRAME_CHARS ||
              parsed.frames.some(
                (frame) => (frame.data?.length ?? 0) > MAX_SSE_FRAME_CHARS
              )
            ) {
              throw new WorkApiError(409, { code: 'resync_required' })
            }
            for (const frame of parsed.frames) {
              if (!frame.data) continue
              let event: WorkTaskEvent
              try {
                event = JSON.parse(frame.data) as WorkTaskEvent
              } catch {
                continue
              }
              if (!event || !event.event_id || event.task_id !== taskId)
                continue
              // The transport cursor is opaque and distinct from event_id.
              if (frame.id) cursor = frame.id
              if (seen.has(event.event_id)) continue
              seen.add(event.event_id)
              if (seen.size > MAX_SEEN_EVENTS) {
                seen.delete(seen.values().next().value!)
              }
              incoming.push(event)
              if (incoming.length > MAX_LIVE_EVENTS) incoming.shift()
            }
          }
          if (incoming.length) {
            setEventState((current) => ({
              taskId,
              events: [...current.events, ...incoming].slice(-MAX_LIVE_EVENTS),
            }))
          }
        }
        schedule()
      } catch (cause) {
        if (stopped || controller.signal.aborted) return
        if (cause instanceof WorkApiError && cause.status === 409) {
          requireResync()
          // Stop transport buffering while the replacement snapshot is pending.
          void reader?.cancel().catch(() => {})
          reader = undefined
          controller.abort()
          try {
            await resync()
          } catch {
            // Keep needsResync set: retry the snapshot, not the expired stream.
          }
          if (stopped) return
        }
        schedule()
      } finally {
        void reader?.cancel().catch(() => {})
        reader = undefined
        controller.abort()
      }
    }

    void connect()
    return () => {
      stopped = true
      controller?.abort()
      void reader?.cancel().catch(() => {})
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [taskId, enabled])

  const events = eventState.taskId === taskId ? eventState.events : EMPTY_EVENTS
  return { events, status, error }
}
