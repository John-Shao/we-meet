import { useTranslation } from 'react-i18next'

import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { buildMeetingCardBody } from '@/features/im/components/meetingCard'

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
  const title = meeting.name || t('home.untitled')

  return (
    <ShareToChatDialog
      body={buildMeetingCardBody({
        v: 1,
        room_id: meeting.id,
        slug: meeting.slug,
        title,
        status: meeting.status,
        scheduled_at: meeting.scheduledAt ?? null,
      })}
      contentType="meeting-card"
      previewText={title}
      errorMessage={t('share.sendFailed', {
        defaultValue: '分享会议失败，请重试',
      })}
      onClose={onClose}
    />
  )
}
