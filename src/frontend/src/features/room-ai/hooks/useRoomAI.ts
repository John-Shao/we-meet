import { useCallback, useState } from 'react'

import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'

import { useAskRoomAI } from '../api/roomAI'

export type RoomAIRole = 'user' | 'assistant'

export interface RoomAIMessage {
  id: string
  role: RoomAIRole
  content: string
  /** Local timestamp; we don't persist server-side. */
  createdAt: number
}

const nextId = () =>
  // crypto.randomUUID is widely available in modern browsers; the fallback
  // is just defensive for older test runners.
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Single-turn-then-replay conversation state for the room sidebar AI.
 *
 * The backend is stateless and single-turn — every ``ask()`` call only
 * sends the latest question, with full transcripts as context. We keep
 * the displayed messages locally so users can scroll back through what
 * they asked; closing the sidebar / leaving the room drops everything.
 */
export const useRoomAI = () => {
  const roomData = useRoomData()
  const roomId = roomData?.livekit?.room ?? roomData?.id
  const token = roomData?.livekit?.token

  const [messages, setMessages] = useState<RoomAIMessage[]>([])
  const mutation = useAskRoomAI()

  const isReady = !!roomId && !!token

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question || !roomId || !token) return

      const userMessage: RoomAIMessage = {
        id: nextId(),
        role: 'user',
        content: question,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, userMessage])

      try {
        const result = await mutation.mutateAsync({
          roomId,
          token,
          question,
        })
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: result.answer,
            createdAt: Date.now(),
          },
        ])
      } catch {
        // The mutation's `error` field carries the ApiError; surface it
        // in the UI via mutation.error rather than mutating messages so
        // users can retry without a phantom assistant bubble.
      }
    },
    [mutation, roomId, token]
  )

  const reset = useCallback(() => {
    setMessages([])
    mutation.reset()
  }, [mutation])

  return {
    messages,
    ask,
    reset,
    isAsking: mutation.isPending,
    error: mutation.error,
    isReady,
  }
}
