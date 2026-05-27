import { useCallback, useState } from 'react'

import { useAskPersonalAI } from '../api/personalAI'
import { PersonalAIRoomRef } from '../api/ApiPersonalAI'

export type PersonalAIRole = 'user' | 'assistant'

export interface PersonalAIMessage {
  id: string
  role: PersonalAIRole
  content: string
  /** Only set on assistant messages; surfaces clickable room chips. */
  roomsReferenced?: PersonalAIRoomRef[]
  createdAt: number
}

const nextId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Single-turn-then-replay conversation state for the cross-meeting AI.
 *
 * Backend is stateless and single-turn — every ask() sends just the latest
 * question with full server-side RAG context assembled from the user's
 * accessible meetings. We keep the displayed messages locally so users can
 * scroll back through what they asked; closing the drawer drops state.
 */
export const usePersonalAI = () => {
  const [messages, setMessages] = useState<PersonalAIMessage[]>([])
  const mutation = useAskPersonalAI()

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim()
      if (!question) return

      const userMessage: PersonalAIMessage = {
        id: nextId(),
        role: 'user',
        content: question,
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, userMessage])

      try {
        const result = await mutation.mutateAsync({ question })
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: result.answer,
            roomsReferenced: result.rooms_referenced,
            createdAt: Date.now(),
          },
        ])
      } catch {
        // Surface via mutation.error to keep the user's draft state clean.
      }
    },
    [mutation]
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
  }
}
