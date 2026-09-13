import { createContext, useContext } from 'react'
import type { RemoteParticipant } from 'livekit-client'
import type {
  InterpretationChannel,
  InterpretationLanguage,
  InterpretationRow,
} from './interpretationEvents'

export interface InterpretationState {
  visible: boolean
  available: boolean
  archiveAvailable?: boolean
  canControl: boolean
  canJoin: boolean
  channels: InterpretationChannel[]
  listening?: string
  muted: boolean
  ready: boolean
  pending: boolean
  uncertain: boolean
  error: boolean
  rows: InterpretationRow[]
  speakerName: (sid: string) => string | undefined
  control: (
    target: InterpretationLanguage,
    operation: 'start' | 'stop',
    saveTranslations?: boolean
  ) => Promise<void>
  choose: (channel?: InterpretationChannel) => Promise<void>
  resubmit: () => Promise<void>
  toggleSound: () => void
  canPlay: (participant: RemoteParticipant, trackSid: string) => boolean
}
export const InterpretationContext = createContext<InterpretationState | null>(
  null
)
export const useInterpretation = () => useContext(InterpretationContext)
