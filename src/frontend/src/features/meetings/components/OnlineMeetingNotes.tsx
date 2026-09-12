import { useRoomContext } from '@livekit/components-react'
import { useQuery } from '@tanstack/react-query'
import { ConnectionState, RoomEvent } from 'livekit-client'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { useRoomId } from '@/features/rooms/livekit/hooks/useRoomId'
import { Button, Text } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { css } from '@/styled-system/css'

import type {
  ApiMeetingRecord,
  ApiRecordTranscript,
  MeetingRecordPage,
} from '../api/ApiMeetingRecord'
import { RecordSummaryPanel } from './RecordSummaryPanel'

export const OnlineMeetingNotes = () => {
  const room = useRoomContext()
  const roomId = useRoomId()
  const { user, isLoggedIn } = useUser()
  const { t } = useTranslation('meetings')
  const [sid, setSid] = useState<string>()
  useEffect(() => {
    let active = true
    let request = 0
    const update = () => {
      const current = ++request
      setSid(undefined)
      if (room.state === ConnectionState.Connected) {
        void room
          .getSid()
          .then((value) => {
            if (active && request === current) setSid(value)
          })
          .catch(() => {})
      }
    }
    update()
    room.on(RoomEvent.Connected, update)
    room.on(RoomEvent.Reconnected, update)
    room.on(RoomEvent.Disconnected, update)
    return () => {
      active = false
      room.off(RoomEvent.Connected, update)
      room.off(RoomEvent.Reconnected, update)
      room.off(RoomEvent.Disconnected, update)
    }
  }, [room, roomId])
  if (!isLoggedIn || !user)
    return <StateHint>{t('recordAi.online.signIn')}</StateHint>
  if (!roomId || !sid)
    return <StateHint>{t('recordAi.online.connecting')}</StateHint>
  return (
    <OnlineMeetingRecord
      key={`${user.id}:${roomId}:${sid}`}
      roomId={roomId}
      sid={sid}
      viewerId={user.id}
    />
  )
}

export const OnlineMeetingRecord = ({
  roomId,
  sid,
  viewerId,
}: {
  roomId: string
  sid: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const [tab, setTab] = useState<'text' | 'summary'>('text')
  const record = useQuery<ApiMeetingRecord, ApiError>({
    queryKey: ['meeting-records', viewerId, 'live-source', roomId, sid],
    queryFn: ({ signal }) =>
      fetchApi(
        `meeting-records/resolve/?${new URLSearchParams({ room_id: roomId, livekit_room_sid: sid })}`,
        { signal }
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.error && query.state.error.statusCode !== 404 ? false : 5000,
  })
  if (record.isError)
    return (
      <StateHint>
        {t(
          record.error.statusCode === 404
            ? 'recordAi.online.waiting'
            : 'recordAi.unavailable'
        )}
      </StateHint>
    )
  if (!record.data) return <StateHint state="loading">{t('loading')}</StateHint>
  const textAllowed = record.data.capabilities.read_transcript
  const summaryAllowed = record.data.capabilities.read_summary
  const selected =
    textAllowed && (tab === 'text' || !summaryAllowed) ? 'text' : 'summary'
  return (
    <div
      className={css({
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        minWidth: 0,
      })}
    >
      <div role="group" aria-label={t('recordAi.online.tabs')}>
        {textAllowed && (
          <Button
            size="sm"
            variant="tertiary"
            aria-pressed={selected === 'text'}
            onPress={() => setTab('text')}
          >
            {t('recordAi.online.text')}
          </Button>
        )}
        {summaryAllowed && (
          <Button
            size="sm"
            variant="tertiary"
            aria-pressed={selected === 'summary'}
            onPress={() => setTab('summary')}
          >
            {t('recordAi.online.summary')}
          </Button>
        )}
      </div>
      {selected === 'text' && textAllowed ? (
        <OnlineRecordText
          key={`${viewerId}:${record.data.id}`}
          recordId={record.data.id}
          viewerId={viewerId}
        />
      ) : summaryAllowed ? (
        <RecordSummaryPanel
          key={`${viewerId}:${record.data.id}`}
          recordId={record.data.id}
          viewerId={viewerId}
        />
      ) : (
        <StateHint>{t('recordAi.unavailable')}</StateHint>
      )}
    </div>
  )
}

const OnlineRecordText = ({
  recordId,
  viewerId,
}: {
  recordId: string
  viewerId: string
}) => {
  const { t } = useTranslation('meetings')
  const [cursor, setCursor] = useState<string>()
  const rows = useQuery<MeetingRecordPage<ApiRecordTranscript>, ApiError>({
    queryKey: ['meeting-records', viewerId, 'live-text', recordId, cursor],
    queryFn: ({ signal }) =>
      fetchApi(
        `meeting-records/${encodeURIComponent(recordId)}/transcripts/?${new URLSearchParams({ order: 'latest', ...(cursor ? { cursor } : {}) })}`,
        { signal }
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => (cursor || query.state.error ? false : 5000),
  })
  if (rows.isError)
    return <StateHint state="error">{t('recordAi.unavailable')}</StateHint>
  if (!rows.data) return <StateHint state="loading">{t('loading')}</StateHint>
  return (
    <section aria-label={t('recordAi.online.text')}>
      <Text variant="note">{t('recordAi.online.textHint')}</Text>
      {rows.data.next_cursor && (
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setCursor(rows.data!.next_cursor!)}
        >
          {t('recordAi.online.earlier')}
        </Button>
      )}
      {rows.data.results.length === 0 && (
        <StateHint>{t('recordAi.online.waiting')}</StateHint>
      )}
      {[...rows.data.results].reverse().map((row) => (
        <article
          key={row.id}
          className={css({ paddingY: '0.75rem', wordBreak: 'break-word' })}
        >
          <Text variant="note">
            {row.speaker_name || t('recordAi.online.unknownSpeaker')} ·{' '}
            {new Date(row.started_at).toLocaleTimeString()}
          </Text>
          <Text>{row.text}</Text>
        </article>
      ))}
      {cursor && (
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => setCursor(undefined)}
        >
          {t('recordAi.online.latest')}
        </Button>
      )}
    </section>
  )
}
