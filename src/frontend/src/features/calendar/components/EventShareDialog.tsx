import { useTranslation } from 'react-i18next'

import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { buildEventCardBody } from '@/features/im/components/eventCard'

import type { CalendarEvent } from '../api/ApiCalendar'

/**
 * 分享日程到聊天(对标飞书日程详情的「分享」)。
 *
 * 复用 P8 已有的 `event-card` 协议 —— 卡片体是分享时刻的快照(标题/起止/
 * 参与人数/组织者),与创建日程时客户端回发的卡片同构,收端双端都已能渲染。
 * 选会话 / 新建群再发的那套交互统一由 ShareToChatDialog 承担。
 */
export const EventShareDialog = ({
  event,
  onClose,
}: {
  event: CalendarEvent
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')

  return (
    <ShareToChatDialog
      body={buildEventCardBody(event)}
      contentType="event-card"
      previewText={event.title}
      errorMessage={t('detail.shareFailed')}
      onClose={onClose}
    />
  )
}
