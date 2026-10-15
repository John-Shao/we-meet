import { createContext, useContext } from 'react'
import type { Participant } from 'livekit-client'

export type RequestAvailability =
  | 'hidden'
  | 'available'
  | 'busy'
  | 'desktopRequired'
  | 'versionMismatch'

export const ControllerContext = createContext<{
  canRequest: (participant: Participant) => boolean
  requestAvailability: (participant: Participant) => RequestAvailability
  request: (participant: Participant) => void
}>({
  canRequest: () => false,
  requestAvailability: () => 'hidden',
  request: () => {},
})
export const useRemoteController = () => useContext(ControllerContext)
