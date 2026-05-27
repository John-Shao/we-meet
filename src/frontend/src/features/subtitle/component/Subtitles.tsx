import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubtitles } from '../hooks/useSubtitles'
import {
  isSameLanguage,
  pickTranslation,
  useTranslations,
  type SpeakerTranslation,
} from '../hooks/useTranslations'
import { css, cva } from '@/styled-system/css'
import { styled } from '@/styled-system/jsx'
import { Avatar } from '@/components/Avatar'
import { Text } from '@/primitives'
import { useRoomContext } from '@livekit/components-react'
import { getParticipantColor } from '@/features/rooms/utils/getParticipantColor'
import { getParticipantName } from '@/features/rooms/utils/getParticipantName'
import { Participant, RoomEvent } from 'livekit-client'
import { useSnapshot } from 'valtio'
import {
  accessibilityStore,
  CAPTION_TEXT_SIZE_OPTIONS,
  CAPTION_FONT_COLOR_VALUES,
  CAPTION_BACKGROUND_COLOR_VALUES,
  type CaptionTextSize,
} from '@/stores/accessibility'

const FONT_SIZE_CONFIG: Record<
  CaptionTextSize,
  { fontSize: string; lineHeight: string }
> = {
  small: { fontSize: '0.875rem', lineHeight: '1.2rem' },
  medium: { fontSize: '1.5rem', lineHeight: '1.7rem' },
  large: { fontSize: '2.25rem', lineHeight: '2.5rem' },
}

const CAPTION_FONT_SIZES = Object.fromEntries(
  CAPTION_TEXT_SIZE_OPTIONS.map((size) => [size, FONT_SIZE_CONFIG[size]])
) as Record<CaptionTextSize, { fontSize: string; lineHeight: string }>

export interface TranscriptionSegment {
  id: string
  text: string
  language: string
  startTime?: number
  endTime: number
  final: boolean
  firstReceivedTime: number
  lastReceivedTime: number
}

export interface TranscriptionSegmentWithParticipant extends TranscriptionSegment {
  participant: Participant
}

export interface TranscriptionRow {
  id: string
  participant: Participant
  segments: TranscriptionSegment[]
  startTime?: number
  lastUpdateTime: number
  lastReceivedTime: number
}

const useTranscriptionState = () => {
  const [transcriptionSegments, setTranscriptionSegments] = useState<
    TranscriptionSegmentWithParticipant[]
  >([])

  const updateTranscriptionSegments = (
    segments: TranscriptionSegment[],
    participant?: Participant
  ) => {
    console.log(participant, segments)

    if (!participant || segments.length === 0) return

    if (segments.length > 1) {
      console.warn('Unexpected error more segments')
      return
    }

    const segment = segments[0]

    setTranscriptionSegments((prevSegments) => {
      const existingSegmentIds = new Set(prevSegments.map((s) => s.id))
      if (existingSegmentIds.has(segment.id)) return prevSegments
      return [
        ...prevSegments,
        {
          participant: participant,
          ...segment,
        },
      ]
    })
  }

  return {
    updateTranscriptionSegments,
    transcriptionSegments,
  }
}

interface TranscriptionProps {
  row: TranscriptionRow
  speakerTranslation?: SpeakerTranslation
  uiLanguage: string
}

const Transcription = ({
  row,
  speakerTranslation,
  uiLanguage,
}: TranscriptionProps) => {
  const { captionTextSize, captionFontColor, captionBackgroundColor } =
    useSnapshot(accessibilityStore)
  const participantColor = getParticipantColor(row.participant)
  const participantName = getParticipantName(row.participant)
  const { fontSize, lineHeight } = CAPTION_FONT_SIZES[captionTextSize]
  const fontColor = CAPTION_FONT_COLOR_VALUES[captionFontColor]
  const backgroundColor =
    CAPTION_BACKGROUND_COLOR_VALUES[captionBackgroundColor]

  const getDisplayText = (row: TranscriptionRow): string => {
    return row.segments
      .filter((segment) => segment.text.trim())
      .map((segment) => segment.text.trim())
      .join(' ')
  }

  const displayText = getDisplayText(row)

  // Sprint 2.1: pick the best translation for the user's UI language if
  // the speaker's language differs. The agent broadcasts one translation
  // packet per FINAL transcript; we display it under the original line.
  // Match by the speaker's identity + recent timestamp (looser than text
  // equality so interim concatenation doesn't break the join).
  const translatedLine = useMemo(() => {
    if (!speakerTranslation) return null
    if (isSameLanguage(speakerTranslation.language, uiLanguage)) return null
    const text = pickTranslation(speakerTranslation.translations, uiLanguage)
    if (!text) return null
    // Sanity: only show translation if it pertains to roughly the same
    // utterance currently displayed (compare the agent's "text" snapshot
    // to the row's joined display text).
    if (
      displayText.length > 0 &&
      speakerTranslation.text &&
      !displayText.includes(speakerTranslation.text) &&
      !speakerTranslation.text.includes(displayText)
    ) {
      return null
    }
    return text
  }, [speakerTranslation, uiLanguage, displayText])

  if (!displayText) return null

  return (
    <div
      className={css({
        maxWidth: '800px',
        width: '100%',
      })}
    >
      <div
        className={css({
          display: 'flex',
          gap: '0.5rem',
        })}
      >
        <Avatar
          name={participantName}
          bgColor={participantColor}
          context="subtitles"
        />
        <div
          className={css({
            width: '100%',
          })}
          style={{ color: fontColor }}
        >
          <Text variant="h3" margin={false}>
            {participantName}
          </Text>
          <p
            className={css({
              fontWeight: '400',
              borderRadius: '4px',
              padding: '0.125rem 0.25rem',
            })}
            style={{ fontSize, lineHeight, backgroundColor }}
          >
            {displayText}
          </p>
          {translatedLine && (
            <p
              className={css({
                fontWeight: '400',
                borderRadius: '4px',
                padding: '0.125rem 0.25rem',
                marginTop: '0.125rem',
                opacity: 0.78,
                fontStyle: 'italic',
              })}
              style={{ fontSize, lineHeight, backgroundColor }}
            >
              {translatedLine}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

const SubtitlesWrapper = styled(
  'div',
  cva({
    base: {
      width: '100%',
      paddingTop: 'var(--lk-grid-gap)',
      transition: 'height .5s cubic-bezier(0.4,0,0.2,1) 5ms',
    },
    variants: {
      areOpen: {
        true: {
          height: '12rem',
        },
        false: {
          height: '0',
        },
      },
    },
  })
)

export const Subtitles = () => {
  const { areSubtitlesOpen } = useSubtitles()
  const room = useRoomContext()
  const { i18n } = useTranslation()

  const { transcriptionSegments, updateTranscriptionSegments } =
    useTranscriptionState()

  const translationsBySpeaker = useTranslations()

  useEffect(() => {
    if (!room) return
    room.on(RoomEvent.TranscriptionReceived, updateTranscriptionSegments)
    return () => {
      room.off(RoomEvent.TranscriptionReceived, updateTranscriptionSegments)
    }
  }, [room, updateTranscriptionSegments])

  const transcriptionRows = useMemo(() => {
    if (transcriptionSegments.length === 0) return []

    const rows: TranscriptionRow[] = []
    let currentRow: TranscriptionRow | null = null

    for (const segment of transcriptionSegments) {
      const shouldStartNewRow =
        !currentRow ||
        currentRow.participant.identity !== segment.participant.identity

      if (shouldStartNewRow) {
        currentRow = {
          id: `${segment.participant.identity}-${segment.firstReceivedTime}`,
          participant: segment.participant,
          segments: [segment],
          startTime: segment.startTime,
          lastUpdateTime: segment.lastReceivedTime,
          lastReceivedTime: segment.lastReceivedTime,
        }
        rows.push(currentRow)
      } else if (currentRow) {
        currentRow.segments.push(segment)
        currentRow.lastUpdateTime = Math.max(
          currentRow.lastUpdateTime,
          segment.lastReceivedTime
        )
        currentRow.lastReceivedTime = Math.max(
          currentRow.lastReceivedTime,
          segment.lastReceivedTime
        )
      }
    }
    return rows
  }, [transcriptionSegments])

  return (
    <SubtitlesWrapper areOpen={areSubtitlesOpen}>
      <div
        className={css({
          height: '100%',
          width: '100%',
          display: 'flex',
          gap: '1.25rem',
          flexDirection: 'column-reverse',
          overflowAnchor: 'auto',
          overflowY: 'scroll',
          padding: '0 1rem',
          alignItems: 'center',
        })}
      >
        {transcriptionRows
          .slice()
          .reverse()
          .map((row) => (
            <Transcription
              key={row.id}
              row={row}
              speakerTranslation={
                translationsBySpeaker[row.participant.identity]
              }
              uiLanguage={i18n.language}
            />
          ))}
      </div>
    </SubtitlesWrapper>
  )
}
