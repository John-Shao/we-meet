import { RiFileList3Line } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import { SenderLabel } from './SenderLabel'

import { Avatar } from './Avatar'
import { chatCardColumn, chatCardSize } from './chatCardSize'
import { parseMeetingRecordCard } from './meetingRecordCard'

/**
 * 分享会议记录到聊天(content_type='meeting-record-card')的卡片气泡。
 *
 * 与 doc-card 同构:**普通**消息行(头像/名字/左右对齐,可右键转发),
 * 卡片内容是分享时刻的静态快照。点卡片 → 打开会议记录工作区,直接落到
 * 纪要页签(`?tab=summary`)—— 分享的动机就是「给你看这份纪要」。
 *
 * ⚠️ 与 meeting-card(会议邀请)的区别:那张卡点进去是**加入会议**,这张是
 * **读记录**。两者都用 `navigateTo`,但目标路由不同。
 */
export const MeetingRecordCardMessage = ({
  body,
  isOwn = false,
  senderName,
  senderBot,
  senderAvatarUrl,
  showSender = false,
  onAvatarClick,
  onContextMenu,
  onOpen,
}: {
  body: string
  isOwn?: boolean
  senderName?: string
  /** Set when the sender is a group bot — chip + description. */
  senderBot?: { description?: string }
  senderAvatarUrl?: string
  /** 群聊且非自己 → 气泡上方显示发送人名字。 */
  showSender?: boolean
  onAvatarClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onOpen?: (card: { record_id: string }) => void
}) => {
  const { t, i18n } = useTranslation('im')
  const card = parseMeetingRecordCard(body)

  let cardEl: React.ReactNode
  if (!card) {
    cardEl = <span className={fallbackCls}>{t('preview.record')}</span>
  } else {
    const clickable = !!onOpen
    const when = card.origin_at
      ? new Intl.DateTimeFormat(i18n.language || undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(card.origin_at))
      : null
    cardEl = (
      <button
        type="button"
        disabled={!clickable}
        onClick={() => clickable && onOpen?.({ record_id: card.record_id })}
        data-testid="im-msg-meeting-record-card"
        className={`${chatCardSize({ size: 'standard' })} ${css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '0.25rem',
          textAlign: 'left',
          // 与 meeting-card 的蓝色区分:记录/纪要归「文档」一族的绿,避免
          // 用户在聊天里把「去读纪要」看成「去开会」。
          backgroundColor: 'greyscale.000',
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '0.75rem',
          paddingX: '0.875rem',
          paddingY: '0.625rem',
          cursor: 'pointer',
          _disabled: { cursor: 'default' },
          _hover: { backgroundColor: 'greyscale.50' },
        })}`}
      >
        <span
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            color: 'greyscale.900',
          })}
        >
          <RiFileList3Line
            size={16}
            className={css({ flexShrink: 0, color: 'primary.600' })}
          />
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
          >
            {card.title || t('preview.record')}
          </span>
        </span>
        <span
          className={css({ fontSize: '0.8125rem', color: 'greyscale.700' })}
        >
          {when ?? t('preview.record')}
        </span>
        {clickable && (
          <span
            className={css({
              fontSize: '0.75rem',
              color: 'primary.600',
              fontWeight: 'medium',
              textAlign: 'right',
            })}
          >
            {t('meetingRecordCard.view')}
          </span>
        )}
      </button>
    )
  }

  const name = senderName || ''
  return (
    <div
      onContextMenu={onContextMenu}
      className={css({
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.5rem',
        justifyContent: isOwn ? 'flex-end' : 'flex-start',
        paddingX: '1rem',
        paddingY: '0.25rem',
      })}
      data-testid="im-msg-meeting-record"
    >
      {!isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={avatarBtnCls}
        >
          <Avatar name={name} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
      <div className={chatCardColumn({ own: isOwn })}>
        {!isOwn && showSender && <SenderLabel name={name} bot={senderBot} />}
        {cardEl}
      </div>
      {isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={avatarBtnCls}
        >
          <Avatar name={name} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
    </div>
  )
}

const avatarBtnCls = css({
  flexShrink: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  _disabled: { cursor: 'default' },
})

const fallbackCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  backgroundColor: 'greyscale.100',
  borderRadius: '0.5rem',
  paddingX: '0.625rem',
  paddingY: '0.25rem',
})
