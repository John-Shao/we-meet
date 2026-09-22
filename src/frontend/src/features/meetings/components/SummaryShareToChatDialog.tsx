import { useTranslation } from 'react-i18next'

import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { buildMeetingRecordCardBody } from '@/features/im/components/meetingRecordCard'

/**
 * 把一条会议记录(纪要)分享到聊天。
 *
 * 卡片是静态快照(`meeting-record-card`),点开进记录工作区的纪要页签 ——
 * 分享的人想的是「给你看这份纪要」。**不夹带授权**:卡片只是通知与入口,
 * 接收者要能读还得在「协作管理」里被授权(或本就有会议角色带来的可见性)。
 * 这与云文档的「分享到聊天顺带授权」刻意不同 —— 纪要的读取权按人授权、
 * 有原文/纪要两层,顺手发一张卡就给人开权限说不清授了什么。
 */
export const SummaryShareToChatDialog = ({
  recordId,
  title,
  originAt,
  onClose,
}: {
  recordId: string
  title: string
  originAt?: string | null
  onClose: () => void
}) => {
  const { t } = useTranslation('meetings')

  return (
    <ShareToChatDialog
      body={buildMeetingRecordCardBody({ recordId, title, originAt })}
      contentType="meeting-record-card"
      previewText={title}
      title={t('summarySharing.chat')}
      errorMessage={t('summarySharing.chatFailed')}
      onClose={onClose}
    />
  )
}
