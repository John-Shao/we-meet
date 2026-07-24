import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/ConfirmProvider'
import { GroupPicker } from '@/features/im/components/GroupPicker'
import { ForwardDialog } from '@/features/im/components/ForwardDialog'
import { buildMeetingCardBody } from '@/features/im/components/meetingCard'
import { createGroupConversation } from '@/features/im/api/createGroupConversation'
import { useForwardConversations } from '@/features/im/hooks/useForwardConversations'

export interface ShareableMeeting {
  id: string
  slug: string
  name: string
  status: 'scheduled' | 'ongoing'
  scheduledAt?: string | null
}

/** Share a joinable meeting card to existing chats or a newly-created group. */
export const MeetingShareDialog = ({
  meeting,
  onClose,
}: {
  meeting: ShareableMeeting
  onClose: () => void
}) => {
  const { t } = useTranslation('meetings')
  const { alert } = useConfirm()
  const { client, conversations } = useForwardConversations()
  const [creatingGroup, setCreatingGroup] = useState(false)
  const body = buildMeetingCardBody({
    v: 1,
    room_id: meeting.id,
    slug: meeting.slug,
    title: meeting.name || t('home.untitled'),
    status: meeting.status,
    scheduled_at: meeting.scheduledAt ?? null,
  })

  const send = async (cids: string[]) => {
    try {
      for (const cid of cids)
        await client.sendText(cid, body, { contentType: 'meeting-card' })
      onClose()
    } catch {
      void alert({ message: t('share.sendFailed', { defaultValue: '分享会议失败，请重试' }) })
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
              void alert({ message: t('share.sendFailed', { defaultValue: '分享会议失败，请重试' }) })
            }
          })()
        }}
      />
    )

  return (
    <ForwardDialog
      conversations={conversations}
      previewText={meeting.name || t('home.untitled')}
      onConfirm={(cids) => void send(cids)}
      onCreateGroupForward={() => setCreatingGroup(true)}
      onClose={onClose}
    />
  )
}
