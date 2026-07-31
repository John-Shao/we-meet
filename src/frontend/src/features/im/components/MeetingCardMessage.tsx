import { RiVidiconLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { navigateTo } from '@/navigation/navigateTo'

import { Avatar } from './Avatar'
import { parseMeetingCard } from './meetingCard'

/**
 * 分享会议到聊天(content_type='meeting-card')的卡片气泡。
 *
 * 与 doc-card 一样是普通消息行:头像/名字/左右对齐、可右键转发。点卡片按 slug
 * 进入房间。内容是分享时刻的静态快照,不追更。
 */
export const MeetingCardMessage = ({
  body,
  isOwn = false,
  senderName,
  senderAvatarUrl,
  showSender = false,
  onAvatarClick,
  onContextMenu,
}: {
  body: string
  isOwn?: boolean
  senderName?: string
  senderAvatarUrl?: string
  /** 群聊且非自己 → 气泡上方显示发送人名字。 */
  showSender?: boolean
  onAvatarClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) => {
  const { t, i18n } = useTranslation('im')
  const card = parseMeetingCard(body)

  let cardEl: React.ReactNode
  if (!card) {
    cardEl = <span className={fallbackCls}>{t('preview.meeting')}</span>
  } else {
    const when = card.scheduled_at
      ? new Intl.DateTimeFormat(i18n.language || undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(card.scheduled_at))
      : null
    cardEl = (
      <button
        type="button"
        onClick={() => navigateTo('room', card.slug)}
        data-testid="im-msg-meeting-card"
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '0.35rem',
          minWidth: '240px',
          maxWidth: '320px',
          textAlign: 'left',
          // 卡片内的标题/副标题走会翻转的 greyscale.900/700,底色必须一起翻,
          // 否则深色下是浅灰字压固定浅蓝底 —— 整张卡读不出来。
          backgroundColor: 'brand.50',
          border: '1px solid token(colors.brand.200)',
          borderRadius: '0.75rem',
          paddingX: '0.875rem',
          paddingY: '0.625rem',
          cursor: 'pointer',
          _hover: { backgroundColor: 'brand.100' },
        })}
      >
        <span
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontWeight: 'medium',
            color: 'greyscale.900',
          })}
        >
          <RiVidiconLine size={17} className={css({ flexShrink: 0, color: 'brand.600' })} />
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            })}
          >
            {card.title}
          </span>
        </span>
        <span className={css({ fontSize: '0.8125rem', color: 'greyscale.700' })}>
          {card.status === 'ongoing'
            ? t('meetingCard.ongoing', { defaultValue: '进行中' })
            : when || t('meetingCard.scheduled', { defaultValue: '已预约会议' })}
        </span>
        <span
          className={css({
            fontSize: '0.75rem',
            color: 'brand.700',
            fontWeight: 'medium',
            textAlign: 'right',
          })}
        >
          {t('meetingCard.join', { defaultValue: '加入会议' })}
        </span>
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
      data-testid="im-msg-meeting"
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
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '70%',
          alignItems: isOwn ? 'flex-end' : 'flex-start',
        })}
      >
        {!isOwn && showSender && (
          <div
            className={css({
              fontSize: '0.75rem',
              color: 'greyscale.600',
              marginBottom: '0.25rem',
              paddingX: '0.25rem',
            })}
          >
            {name}
          </div>
        )}
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

const fallbackCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
