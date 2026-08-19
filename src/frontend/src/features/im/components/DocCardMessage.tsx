import { useTranslation } from 'react-i18next'
import { RiFileTextLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

import { SenderLabel } from './SenderLabel'

import { Avatar } from './Avatar'
import { parseDocCard } from './docCard'

/**
 * 分享云文档到聊天(content_type='doc-card')的卡片气泡。
 *
 * 与 event-card 不同,doc-card 从不由后端 SYSTEM 注入,永远是普通消息行
 * (头像/名字/左右对齐,可右键转发)——不需要 EventCardMessage 那种
 * system-居中变体。卡片内容是分享时刻的静态快照,不追更。
 */
export const DocCardMessage = ({
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
  onOpen?: (card: { doc_id: string; url: string }) => void
}) => {
  const { t } = useTranslation('im')
  const card = parseDocCard(body)

  let cardEl: React.ReactNode
  if (!card) {
    cardEl = <span className={fallbackCls}>{t('preview.doc')}</span>
  } else {
    const clickable = !!card.doc_id && !!card.url && !!onOpen

    cardEl = (
      <button
        type="button"
        disabled={!clickable}
        onClick={() =>
          clickable && onOpen?.({ doc_id: card.doc_id, url: card.url })
        }
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '0.25rem',
          minWidth: '240px',
          maxWidth: '320px',
          textAlign: 'left',
          backgroundColor: 'greyscale.000',
          border: '1px solid token(colors.greyscale.200)',
          borderRadius: '0.75rem',
          paddingX: '0.875rem',
          paddingY: '0.625rem',
          cursor: 'pointer',
          _disabled: { cursor: 'default' },
          _hover: { backgroundColor: 'greyscale.50' },
        })}
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
          <RiFileTextLine
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
            {card.title || t('preview.doc')}
          </span>
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
            {t('docCard.view')}
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
      data-testid="im-msg-doc-card"
    >
      {!isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={css({
            flexShrink: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            _disabled: { cursor: 'default' },
          })}
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
        {!isOwn && showSender && <SenderLabel name={name} bot={senderBot} />}
        {cardEl}
      </div>
      {isOwn && (
        <button
          type="button"
          onClick={onAvatarClick}
          disabled={!onAvatarClick}
          aria-label={name}
          className={css({
            flexShrink: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            _disabled: { cursor: 'default' },
          })}
        >
          <Avatar name={name} src={senderAvatarUrl} size="2rem" />
        </button>
      )}
    </div>
  )
}

const fallbackCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  backgroundColor: 'greyscale.100',
  borderRadius: '0.5rem',
  paddingX: '0.625rem',
  paddingY: '0.25rem',
})
