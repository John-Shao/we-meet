import { useEffect, useState } from 'react'

import {
  DataPacket_Kind,
  RemoteParticipant,
  RoomEvent,
} from 'livekit-client'
import { useRoomContext } from '@livekit/components-react'

const TRANSLATION_TOPIC = 'lk.transcription.translation'

interface TranslationPayload {
  speaker_identity: string
  text: string
  language: string
  translations: Record<string, string>
  started_at: string
}

export interface SpeakerTranslation {
  text: string
  language: string
  translations: Record<string, string>
  receivedAt: number
}

// Keep only this many recent translations per speaker; older entries
// are pruned to bound memory in long meetings.
const MAX_HISTORY_PER_SPEAKER = 50

/**
 * Subscribe to the agent's translation DataChannel and keep, per speaker,
 * an ordered history of recent ``(original text, translations)`` packets.
 *
 * Each FINAL transcript emits one packet; ``Subtitles.tsx`` joins them by
 * speaker + a time window so multi-sentence transcription rows show their
 * full translated counterpart rather than only the latest sentence.
 */
export const useTranslations = () => {
  const room = useRoomContext()
  const [historyBySpeaker, setHistoryBySpeaker] = useState<
    Record<string, SpeakerTranslation[]>
  >({})

  useEffect(() => {
    if (!room) return

    const handler = (
      payload: Uint8Array,
      _participant?: RemoteParticipant,
      _kind?: DataPacket_Kind,
      topic?: string
    ) => {
      if (topic !== TRANSLATION_TOPIC) return
      try {
        const parsed = JSON.parse(
          new TextDecoder().decode(payload)
        ) as TranslationPayload
        if (!parsed.speaker_identity || !parsed.text) return
        const entry: SpeakerTranslation = {
          text: parsed.text,
          language: parsed.language || '',
          translations: parsed.translations || {},
          receivedAt: Date.now(),
        }
        setHistoryBySpeaker((prev) => {
          const prior = prev[parsed.speaker_identity] || []
          const next = [...prior, entry].slice(-MAX_HISTORY_PER_SPEAKER)
          return { ...prev, [parsed.speaker_identity]: next }
        })
      } catch (e) {
        console.warn('Failed to parse translation payload:', e)
      }
    }

    room.on(RoomEvent.DataReceived, handler)
    return () => {
      room.off(RoomEvent.DataReceived, handler)
    }
  }, [room])

  return historyBySpeaker
}

/**
 * Match the i18next UI language to the closest translations-dict key.
 *
 * Backend stores keys like ``zh-cn`` / ``en-us``; i18next.language may be
 * ``zh`` / ``zh-CN`` / ``en`` / ``en-US`` etc. Try exact match first, then
 * case-insensitive, then prefix-only.
 */
export const pickTranslation = (
  translations: Record<string, string>,
  uiLanguage: string
): string | null => {
  if (!uiLanguage) return null
  const lower = uiLanguage.toLowerCase()
  if (translations[lower]) return translations[lower]

  const prefix = lower.split('-')[0]
  for (const key of Object.keys(translations)) {
    if (key.toLowerCase() === lower) return translations[key]
  }
  for (const key of Object.keys(translations)) {
    if (key.toLowerCase().split('-')[0] === prefix) return translations[key]
  }
  return null
}

/**
 * Is the original transcript language equivalent to the user's UI language?
 *
 * "Equivalent" = same primary subtag (zh ↔ zh-cn ↔ zh-CN).
 */
export const isSameLanguage = (
  transcriptLang: string,
  uiLanguage: string
): boolean => {
  if (!transcriptLang || !uiLanguage) return false
  return (
    transcriptLang.toLowerCase().split('-')[0] ===
    uiLanguage.toLowerCase().split('-')[0]
  )
}
