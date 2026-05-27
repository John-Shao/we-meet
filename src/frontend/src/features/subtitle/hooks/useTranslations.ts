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

/**
 * Subscribe to the agent's translation DataChannel and keep, per speaker,
 * the latest ``(original text, translations)`` pair. The transcriber emits
 * one packet per FINAL transcript with the same shape; subscribers render
 * either the original or a translation by looking up
 * ``translationsBySpeaker[participant.identity]``.
 */
export const useTranslations = () => {
  const room = useRoomContext()
  const [translationsBySpeaker, setTranslationsBySpeaker] = useState<
    Record<string, SpeakerTranslation>
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
        setTranslationsBySpeaker((prev) => ({
          ...prev,
          [parsed.speaker_identity]: {
            text: parsed.text,
            language: parsed.language || '',
            translations: parsed.translations || {},
            receivedAt: Date.now(),
          },
        }))
      } catch (e) {
        console.warn('Failed to parse translation payload:', e)
      }
    }

    room.on(RoomEvent.DataReceived, handler)
    return () => {
      room.off(RoomEvent.DataReceived, handler)
    }
  }, [room])

  return translationsBySpeaker
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
