import { useCallback, useRef, useState } from 'react'

import { ApiError } from '@/api/ApiError'
import { sseStream } from '@/api/sseStream'

import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'

export type RoomAIRole = 'user' | 'assistant'

export interface RoomAIMessage {
  id: string
  role: RoomAIRole
  content: string
  /** True while still streaming; false once `done` arrived (Sprint 2.5). */
  isStreaming?: boolean
  createdAt: number
}

const nextId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`

const MAX_HISTORY_MESSAGES = 6 // matches backend sanitise_history

/**
 * Streaming, multi-turn conversation state for the room sidebar AI.
 *
 * Sprint 2.5 — same shape as `usePersonalAI`:
 *   * POSTs to `/rooms/{id}/ask-ai-stream/` with the LiveKit token in
 *     the `Authorization` header (the endpoint authenticates against
 *     the room's LiveKit token, not the user session).
 *   * `meta` event triggers nothing visible here (Room AI doesn't surface
 *     room chips — the user is already in the room).
 *   * `delta` events stream into the assistant bubble's `content`.
 *   * The last MAX_HISTORY_MESSAGES messages ride along as `history`
 *     so follow-up questions ("下班呢？") resolve correctly.
 */
export const useRoomAI = () => {
  const roomData = useRoomData()
  const roomId = roomData?.livekit?.room ?? roomData?.id
  const token = roomData?.livekit?.token

  const [messages, setMessages] = useState<RoomAIMessage[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isReady = !!roomId && !!token

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question || !roomId || !token || isAsking) return

      const history = messages
        .filter((m) => !m.isStreaming && m.content)
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }))

      const userMsg: RoomAIMessage = {
        id: nextId(),
        role: 'user',
        content: question,
        createdAt: Date.now(),
      }
      const asstId = nextId()
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: asstId,
          role: 'assistant',
          content: '',
          isStreaming: true,
          createdAt: Date.now(),
        },
      ])
      setError(null)
      setIsAsking(true)

      const ctrl = new AbortController()
      abortRef.current = ctrl

      try {
        for await (const ev of sseStream(`rooms/${roomId}/ask-ai-stream/`, {
          body: { question, history },
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        })) {
          if (ev.type === 'delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId ? { ...m, content: m.content + ev.text } : m
              )
            )
          } else if (ev.type === 'error') {
            throw new Error(ev.message)
          }
          // meta / done events are no-ops for Room AI.
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        const message =
          e instanceof ApiError
            ? `${e.status}: ${
                typeof e.data === 'object' && e.data && 'error' in e.data
                  ? (e.data as { error: string }).error
                  : 'request failed'
              }`
            : e instanceof Error
              ? e.message
              : String(e)
        setError(new Error(message))
      } finally {
        abortRef.current = null
        setIsAsking(false)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId ? { ...m, isStreaming: false } : m
          )
        )
      }
    },
    [messages, roomId, token, isAsking]
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setError(null)
    setIsAsking(false)
  }, [])

  return { messages, ask, reset, isAsking, error, isReady }
}
