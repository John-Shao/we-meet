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
        left: 'md',
        zIndex: 10,
        maxWidth: 'calc(100% - 1.5rem)',
        paddingY: 'xs',
        paddingX: 'md',
        borderRadius: 'field',
        // default / on-default 必须成对取:不能从 status.danger 借背景、再从别处借前景。
        backgroundColor: 'status.danger',
        color: 'status.danger.text',
        textStyle: 'bodyMedium',
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
