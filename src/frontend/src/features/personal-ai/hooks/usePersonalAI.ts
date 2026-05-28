import { useCallback, useRef, useState } from 'react'

import { ApiError } from '@/api/ApiError'
import { sseStream } from '@/api/sseStream'

import { PersonalAIRoomRef } from '../api/ApiPersonalAI'

export type PersonalAIRole = 'user' | 'assistant'

export interface PersonalAIMessage {
  id: string
  role: PersonalAIRole
  content: string
  /** Only set on assistant messages; surfaces clickable room chips. */
  roomsReferenced?: PersonalAIRoomRef[]
  /** True while still streaming; false once `done` arrived (Sprint 2.5). */
  isStreaming?: boolean
  createdAt: number
}

const nextId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`

const MAX_HISTORY_MESSAGES = 6 // 3 turns; matches backend sanitise_history

/**
 * Single-turn-then-replay conversation state for the cross-meeting AI.
 *
 * Sprint 2.5 — streaming + multi-turn:
 *   * Each `ask()` POSTs to `/users/me/ai/ask-stream/` (SSE).
 *   * `meta` event populates the assistant bubble's `roomsReferenced`
 *     before any text arrives, so citation chips render instantly.
 *   * `delta` events append to `content` (text appears char-by-char).
 *   * `done` clears `isStreaming`. `error` surfaces via `error` state.
 *   * The last MAX_HISTORY_MESSAGES messages are sent back as
 *     `history` so the model resolves follow-up references.
 */
export const usePersonalAI = () => {
  const [messages, setMessages] = useState<PersonalAIMessage[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question || isAsking) return

      // Snapshot history from the existing messages — exclude streaming
      // (or just-appended) ones so we don't send an in-flight assistant
      // bubble with a partial content.
      const history = messages
        .filter((m) => !m.isStreaming && m.content)
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content }))

      const userMsg: PersonalAIMessage = {
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
        for await (const ev of sseStream('users/me/ai/ask-stream/', {
          body: { question, history },
          signal: ctrl.signal,
        })) {
          if (ev.type === 'meta') {
            const rooms = (ev as { rooms_referenced?: PersonalAIRoomRef[] })
              .rooms_referenced
            if (rooms) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId ? { ...m, roomsReferenced: rooms } : m
                )
              )
            }
          } else if (ev.type === 'delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId ? { ...m, content: m.content + ev.text } : m
              )
            )
          } else if (ev.type === 'error') {
            throw new Error(ev.message)
          } else if (ev.type === 'done') {
            // No-op — finally block clears isStreaming.
          }
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
    [messages, isAsking]
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setError(null)
    setIsAsking(false)
  }, [])

  return { messages, ask, reset, isAsking, error }
}
