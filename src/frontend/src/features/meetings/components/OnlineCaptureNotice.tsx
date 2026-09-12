import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'
import { useRoomData } from '@/features/rooms/livekit/hooks/useRoomData'
import { css } from '@/styled-system/css'

import { useConnectedMeetingSid } from '../useConnectedMeetingSid'

export const OnlineCaptureNotice = () => {
  const room = useRoomData()
  const sid = useConnectedMeetingSid()
  if (!room?.livekit?.room || !room.livekit.token || !sid) return null
  return (
    <OnlineCaptureNoticeState
      key={`${room.livekit.room}:${sid}`}
      roomId={room.livekit.room}
      token={room.livekit.token}
      sid={sid}
    />
  )
}

export const OnlineCaptureNoticeState = ({
  roomId,
  sid,
  token,
}: {
  roomId: string
  sid: string
  token: string
}) => {
  const { t } = useTranslation('meetings')
  const status = useQuery<
    {
      state:
        | 'off'
        | 'starting'
        | 'recording'
        | 'stopping'
        | 'stopped'
        | 'incomplete'
    },
    ApiError
  >({
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- never store bearer credentials in cache keys; this is room-public state only
    queryKey: ['online-capture-notice', roomId, sid],
    queryFn: ({ signal }) =>
      fetchApi(
        `meeting-capture-status/?${new URLSearchParams({ room_id: roomId, livekit_room_sid: sid })}`,
        { signal, headers: { Authorization: `Bearer ${token}` } }
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
  })
  if (!status.data || status.data.state === 'off') return null
  return (
    <div
      role="status"
      aria-atomic="true"
      className={css({
        position: 'absolute',
        bottom: '5rem',
        left: '0.75rem',
        zIndex: 10,
        maxWidth: 'calc(100% - 1.5rem)',
        paddingY: '0.25rem',
        paddingX: '0.75rem',
        borderRadius: '4px',
        backgroundColor: 'danger.700',
        color: 'white',
        fontSize: '0.875rem',
      })}
    >
      {t('recordAi.capture.title')} ·{' '}
      {t(
        status.isError
          ? 'recordAi.capture.unavailable'
          : `recordAi.capture.state.${status.data.state}`
      )}
    </div>
  )
}
