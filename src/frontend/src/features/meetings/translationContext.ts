import { createContext, useContext } from 'react'
import type {
  TranslationDirection,
  TranslationRow,
  TranslationRun,
} from './translationEvents'

export interface TranslationOptions {
  source: 'zh' | 'en'
  target: 'zh' | 'en'
  mode: 'simultaneous' | 'push_to_talk'
  audio: boolean
}
export interface PrivateTranslationState {
  visible: boolean
  available: boolean
  current?: TranslationRun | null
  canStart: boolean
  ownConnection: boolean
  pending: boolean
  uncertain: boolean
  error: boolean
  ready: boolean
  muted: boolean
  held: TranslationDirection | null
  turnBusy: boolean
  rows: TranslationRow[]
  change: (options?: TranslationOptions) => Promise<void>
  toggleSound: () => void
  press: (direction: TranslationDirection, begin: boolean) => void
}
export const PrivateTranslationContext =
  createContext<PrivateTranslationState | null>(null)
export const usePrivateTranslation = () => useContext(PrivateTranslationContext)
