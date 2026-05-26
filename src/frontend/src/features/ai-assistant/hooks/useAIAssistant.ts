import { useMemo } from 'react'

import { useParticipants } from '@livekit/components-react'

import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'

import { useStartAIAgent, useStopAIAgent } from '../api/aiAgent'

const AI_AGENT_IDENTITY_PREFIX = 'ai-agent-'

interface StartOptions {
  voiceId?: string | null
  promptId?: string | null
}

/**
 * Manage the AI assistant lifecycle for the current room.
 *
 * - `isActive`            — true when an ai-agent participant is in the room
 * - `start(code, opts)`   — dispatch the AI assistant agent
 * - `stop()`              — remove the AI assistant agent
 */
export const useAIAssistant = () => {
  const roomData = useRoomData()
  const participants = useParticipants()

  const aiParticipant = useMemo(
    () =>
      participants.find((p) =>
        p.identity.startsWith(AI_AGENT_IDENTITY_PREFIX)
      ),
    [participants]
  )

  const startMutation = useStartAIAgent()
  const stopMutation = useStopAIAgent()

  const roomId = roomData?.livekit?.room ?? roomData?.id
  const token = roomData?.livekit?.token

  const start = async (profileCode: string, opts?: StartOptions) => {
    if (!roomId || !token) {
      throw new Error('Room or LiveKit token is not available')
    }
    return startMutation.mutateAsync({
      roomId,
      token,
      profileCode,
      voiceId: opts?.voiceId ?? null,
      promptId: opts?.promptId ?? null,
    })
  }

  const stop = async () => {
    if (!roomId || !token) {
      throw new Error('Room or LiveKit token is not available')
    }
    return stopMutation.mutateAsync({ roomId, token })
  }

  return {
    isActive: !!aiParticipant,
    aiParticipant,
    start,
    stop,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    startError: startMutation.error,
    stopError: stopMutation.error,
    canControl: !!roomId && !!token,
  }
}
