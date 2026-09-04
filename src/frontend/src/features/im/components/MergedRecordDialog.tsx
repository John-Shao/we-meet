import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalHeader } from '@/components/Modal'

/** One line of a merged chat-record (合并转发的聊天记录). */
export interface MergedItem {
  /** Baked-in sender display name (resolved at forward time; “我” for self). */
  sender: string
  /** Plain-text representation of the message (media → [图片]/[文件]/[语音]). */
  text: string
  /** unix ms */
  ts: number
}

/**
 * content_type='merged' 的 body(JSON)。转发时把发送人显示名 + 文本快照烘焙进去,
 * 因为目标会话不一定认识原会话的成员,正文也不落 we-meet 库。
 */
export interface MergedBody {
  title: string
  count: number
  items: MergedItem[]
}

/** Compact timestamp for a merged line: today→HH:MM, else M/D HH:MM. */
const fmtTs = (ts: number, locale: string): string => {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  const datePart = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  })
  return `${datePart} ${hm}`
}

interface Props {
  record: MergedBody
  onClose: () => void
}

/**
 * 合并转发查看器(P7-f):点开一条「聊天记录」卡片,只读展示烘焙进去的多条消息。
 */
export const MergedRecordDialog = ({ record, onClose }: Props) => {
  const { t, i18n } = useTranslation('im')
  return (
    <Modal onClose={onClose} ariaLabel={record.title} maxWidth="460px">
      <ModalHeader
        title={record.title}
        onClose={onClose}
        closeLabel={t('group.cancel')}
      />
      <ModalBody padding="none" minHeight="8rem">
        <div className={recordListCls}>
          {record.items.map((it, idx) => (
            <div key={idx} className={rowCls} data-testid="merged-line">
              <div className={metaCls}>
                <span className={senderCls}>{it.sender}</span>
                <span className={tsCls}>{fmtTs(it.ts, i18n.language)}</span>
              </div>
              <div className={textCls}>{it.text}</div>
            </div>
          ))}
        </div>
      </ModalBody>
    </Modal>
  )
}

const rowCls = css({
  paddingX: '1rem',
  paddingY: '0.5rem',
})

const recordListCls = css({ paddingY: 'sm' })

const metaCls = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
  marginBottom: '0.125rem',
})

const senderCls = css({
  fontSize: '0.8125rem',
  fontWeight: 'medium',
  color: 'greyscale.600',
})

const tsCls = css({
  fontSize: '0.6875rem',
  color: 'greyscale.400',
})

const textCls = css({
  fontSize: '0.875rem',
  color: 'greyscale.900',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
})
