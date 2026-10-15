import { createContext, useContext } from 'react'
import type { Participant } from 'livekit-client'

export const ControllerContext = createContext<{
  canRequest: (participant: Participant) => boolean
  request: (participant: Participant) => void
}>({ canRequest: () => false, request: () => {} })
export const useRemoteController = () => useContext(ControllerContext)
