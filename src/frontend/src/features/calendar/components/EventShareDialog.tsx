import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/ConfirmProvider'
import { GroupPicker } from '@/features/im/components/GroupPicker'
import { ForwardDialog } from '@/features/im/components/ForwardDialog'
import { buildEventCardBody } from '@/features/im/components/eventCard'
import { createGroupConversation } from '@/features/im/api/createGroupConversation'
import { useForwardConversations } from '@/features/im/hooks/useForwardConversations'

import type { CalendarEvent } from '../api/ApiCalendar'

/**
 * 分享日程到聊天(对标飞书日程详情的「分享」)。
 *
 * 复用 P8 已有的 `event-card` 协议 —— 卡片体是分享时刻的快照(标题/起止/
 * 参与人数/组织者),与创建日程时客户端回发的卡片同构,收端双端都已能渲染。
 * 结构对齐 MeetingShareDialog:选会话 → 逐个发;也可新建群再发。
 */
export const EventShareDialog = ({
  event,
  onClose,
}: {
  event: CalendarEvent
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')
  const { alert } = useConfirm()
  const { client, conversations } = useForwardConversations()
  const [creatingGroup, setCreatingGroup] = useState(false)
  const body = buildEventCardBody(event)

  const send = async (cids: string[]) => {
    try {
      for (const cid of cids)
        await client.sendText(cid, body, { contentType: 'event-card' })
      onClose()
    } catch {
      void alert({ message: t('detail.shareFailed') })
    }
  }

  if (creatingGroup)
    return (
      <GroupPicker
        onClose={() => setCreatingGroup(false)}
        onCreate={(memberUserIds, name) => {
          void (async () => {
            try {
              const created = await createGroupConversation(memberUserIds, name)
              await send([created.cid])
            } catch {
              void alert({ message: t('detail.shareFailed') })
            }
          })()
        }}
      />
    )

  return (
    <ForwardDialog
      conversations={conversations}
      previewText={event.title}
      onConfirm={(cids) => void send(cids)}
      onCreateGroupForward={() => setCreatingGroup(true)}
      onClose={onClose}
    />
  )
}
