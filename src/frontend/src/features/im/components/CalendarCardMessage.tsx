import { RiCalendarLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

import { Avatar } from './Avatar'
import { parseCalendarCard } from './calendarCard'
import { SenderLabel } from './SenderLabel'

export const CalendarCardMessage = ({
  body,
  isOwn = false,
  senderName = '',
  senderBot,
  senderAvatarUrl,
  showSender = false,
  onAvatarClick,
  onContextMenu,
}: {
  body: string
  isOwn?: boolean
  senderName?: string
  senderBot?: { description?: string }
  senderAvatarUrl?: string
  showSender?: boolean
  onAvatarClick?: () => void
  onContextMenu?: (event: React.MouseEvent) => void
}) => {
  const card = parseCalendarCard(body)
  const content = card ? (
    <button
      type="button"
      className={cardCls}
      onClick={() => window.location.assign(card.subscribe_url)}
    >
      <span className={headingCls}>
        <RiCalendarLine size={18} /> {card.name}
      </span>
      {card.owner_name && <span>所有者：{card.owner_name}</span>}
      {card.description && (
        <span className={descriptionCls}>{card.description}</span>
      )}
      <span className={footerCls}>
        {card.subscriber_count} 人已订阅 · 查看并订阅
      </span>
    </button>
  ) : (
    <span className={fallbackCls}>日历分享</span>
  )
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
      data-testid="im-msg-calendar-card"
    >
      {!isOwn && (
        <button
          type="button"
          className={avatarBtnCls}
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
        >
          <Avatar name={senderName} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '70%',
          alignItems: isOwn ? 'flex-end' : 'flex-start',
        })}
      >
        {!isOwn && showSender && (
          <SenderLabel name={senderName} bot={senderBot} />
        )}
        {content}
      </div>
      {isOwn && (
        <button
          type="button"
          className={avatarBtnCls}
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
        >
          <Avatar name={senderName} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
    </div>
  )
}

const cardCls = css({
  minWidth: '240px',
  maxWidth: '320px',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
  textAlign: 'left',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.75rem',
  background: 'greyscale.000',
  color: 'greyscale.800',
  padding: '0.8rem',
  cursor: 'pointer',
  _hover: { background: 'greyscale.50' },
})
const headingCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  color: 'primary.600',
  fontWeight: 700,
})
const descriptionCls = css({
  color: 'greyscale.600',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const footerCls = css({
  color: 'primary.600',
  fontSize: '0.75rem',
  textAlign: 'right',
})
const fallbackCls = css({
  color: 'greyscale.500',
  background: 'greyscale.100',
  borderRadius: '0.5rem',
  padding: '0.5rem',
})
const avatarBtnCls = css({
  flexShrink: 0,
  padding: 0,
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  _disabled: { cursor: 'default' },
})
