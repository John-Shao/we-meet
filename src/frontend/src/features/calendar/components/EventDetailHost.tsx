import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useUser } from '@/features/auth'

import {
  deleteCalendarEvent,
  fetchCalendarEvent,
  rsvpCalendarEvent,
} from '../api/fetchCalendar'
import type { EditScope } from '../api/ApiCalendar'
import { CreateEventDialog } from './CreateEventDialog'
import { EditScopeDialog } from './EditScopeDialog'
import { EventDetailDialog } from './EventDetailDialog'
import { EventShareDialog } from './EventShareDialog'

/**
 * P8:按 id 拉取日程并复用现有 EventDetailDialog —— IM 日程卡片点「查看」
 * 的宿主(卡片只带 event_id,详情以服务端为准,天然反映改期/取消)。
 *
 * 与日历页的差异:organizer 的「编辑」以及重复日程的「删除」跳 /calendar
 * (三选范围的 EditScopeDialog 机制不搬进 IM);单次日程的删除在本地直接
 * 确认执行。404/403(已取消/不可见)→ 居中提示。
 */
export const EventDetailHost = ({
  eventId,
  onClose,
  editMode = 'calendar',
}: {
  eventId: string
  onClose: () => void
  /** Keep legacy IM behavior by default; meeting overview edits in place. */
  editMode?: 'calendar' | 'inline'
}) => {
  const { t } = useTranslation('im')
  const [, navigate] = useLocation()
  const { user } = useUser()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const queryClient = useQueryClient()
  // 转分享:详情先关掉再开分享,避免两个 Modal 叠加。
  const [sharing, setSharing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editScope, setEditScope] = useState<EditScope>()
  const [choosingEditScope, setChoosingEditScope] = useState(false)

  const {
    data: event,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['calendar', 'event', eventId],
    queryFn: () => fetchCalendarEvent(eventId),
    retry: false,
    staleTime: 15_000,
  })

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['calendar'] }),
      queryClient.invalidateQueries({ queryKey: ['im', 'freebusy'] }),
      queryClient.invalidateQueries({ queryKey: ['scheduled-meetings'] }),
    ])

  if (isLoading) return null

  if (isError || !event) {
    return (
      <Modal
        onClose={onClose}
        ariaLabel={t('calendar.card.gone')}
        maxWidth="360px"
      >
        <div
          className={css({
            padding: '2rem 1.25rem',
            textAlign: 'center',
            fontSize: '0.875rem',
            color: 'greyscale.600',
          })}
          data-testid="event-detail-gone"
        >
          {t('calendar.card.gone')}
        </div>
      </Modal>
    )
  }

  const toCalendar = () => {
    onClose()
    navigate('/calendar')
  }

  const startEditing = () => {
    if (editMode === 'calendar') {
      toCalendar()
      return
    }
    if (event.recurrence_parent) {
      setChoosingEditScope(true)
      return
    }
    setEditScope(undefined)
    setEditing(true)
  }

  if (choosingEditScope)
    return (
      <EditScopeDialog
        title={t('scope.editTitle', { ns: 'calendar' })}
        options={['one', 'following', 'all']}
        onClose={() => setChoosingEditScope(false)}
        onConfirm={(scope) => {
          setChoosingEditScope(false)
          setEditScope(scope)
          setEditing(true)
        }}
      />
    )

  if (editing)
    return (
      <CreateEventDialog
        editEvent={event}
        editScope={editScope}
        onClose={() => {
          setEditing(false)
          setEditScope(undefined)
        }}
        onCreated={() => {
          onClose()
          void invalidate()
        }}
      />
    )

  if (sharing)
    return <EventShareDialog event={event} onClose={() => setSharing(false)} />

  return (
    <EventDetailDialog
      event={event}
      canManage={!!user && event.organizer?.id === user.id}
      onShare={() => setSharing(true)}
      onEdit={startEditing}
      onDelete={() => {
        // 重复日程的范围三选留在日历页;单次日程就地确认删除。
        if (event.recurrence_parent || event.recurrence) {
          toCalendar()
          return
        }
        void (async () => {
          if (
            !(await askConfirm({
              message: t('calendar.deleteConfirm'),
              danger: true,
            }))
          )
            return
          try {
            await deleteCalendarEvent(event.id)
            await invalidate()
            onClose()
          } catch (e) {
            void showAlert({ message: apiErrorMessage(e) })
          }
        })()
      }}
      onRsvp={(status) => {
        void rsvpCalendarEvent(event.id, status)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: ['calendar', 'event', eventId],
            })
          )
          .then(() => invalidate())
          .catch((e) => showAlert({ message: apiErrorMessage(e) }))
      }}
      onJoin={() => {
        if (event.room_slug) {
          onClose()
          navigate(`/${event.room_slug}`)
        }
      }}
      onClose={onClose}
    />
  )
}
