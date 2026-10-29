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

export const useTaskEventStream = (
  taskId: string | undefined,
  enabled: boolean,
  onResync?: () => void
) => {
  const [events, setEvents] = useState<WorkTaskEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>('closed')
  const [error, setError] = useState<string | null>(null)
  const lastEventIdRef = useRef<string | undefined>(undefined)
  const onResyncRef = useRef(onResync)
  onResyncRef.current = onResync

  useEffect(() => {
    setEvents([])
    setError(null)
    lastEventIdRef.current = undefined
  }, [taskId])

  useEffect(() => {
    if (!taskId || !enabled) {
      setStatus('closed')
      return
    }
    let stopped = false
    let controller: AbortController | undefined
    let timer: number | undefined
    let attempt = 0
    const seen = new Set<string>()

    const schedule = () => {
      if (stopped) return
      const delay = Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500
      attempt += 1
      timer = window.setTimeout(connect, delay)
    }

    const connect = async () => {
      if (stopped) return
      controller = new AbortController()
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      try {
        const response = await openWorkEventStream(
          taskId,
          controller.signal,
          lastEventIdRef.current
        )
        if (!response.ok) {
          if (response.status === 409) {
            setEvents([])
            lastEventIdRef.current = undefined
            onResyncRef.current?.()
            if (!stopped) schedule()
            return
          }
          let code = ''
          try {
            const body = (await response.json()) as { code?: string }
            code = body.code ?? ''
          } catch {
            /* gateway error */
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404
          ) {
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
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!stopped) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseFrames(buffer)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            if (!frame.data) continue
            let event: WorkTaskEvent
            try {
              event = JSON.parse(frame.data) as WorkTaskEvent
            } catch {
              continue
            }
            if (!event.event_id || seen.has(event.event_id)) continue
            seen.add(event.event_id)
            if (frame.id) lastEventIdRef.current = frame.id
            setEvents((current) => [...current, event])
          }
        }
        if (!stopped) schedule()
      } catch (cause) {
        if (stopped || controller?.signal.aborted) return
        if (cause instanceof WorkApiError && cause.status === 409) {
          onResyncRef.current?.()
          lastEventIdRef.current = undefined
          setEvents([])
        }
        setStatus('reconnecting')
        schedule()
      }
    }

    connect()
    return () => {
      stopped = true
      controller?.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [taskId, enabled])

  return { events, status, error }
}
