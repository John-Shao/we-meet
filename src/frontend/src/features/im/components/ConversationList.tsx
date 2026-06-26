import { useTranslation } from 'react-i18next'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { Avatar } from './Avatar'

interface Props {
  conversations: ConversationSummary[]
  selectedCID: string | null
  onSelect: (cid: string) => void
  loading?: boolean
  /** Resolve a conversation's display label (group name / direct peer name). */
  nameOf: (c: ConversationSummary) => string
  /** Delete (direct) / leave (group) the conversation. */
  onDelete: (c: ConversationSummary) => void
  /** cids with an unread @-mention of the current user → show a red "@" marker. */
  mentionedCids?: Set<string>
}

export const ConversationList = ({
  conversations,
  selectedCID,
  onSelect,
  loading,
  nameOf,
  onDelete,
  mentionedCids,
}: Props) => {
  const { t } = useTranslation('im')

  if (loading) {
    return (
      <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
        {t('list.loading')}
      </div>
    )
  }
  if (conversations.length === 0) {
    return (
      <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
        {t('list.empty')}
      </div>
    )
  }

  return (
    <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
      {conversations.map((c) => (
        <li
          key={c.cid}
          className={css({
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: '1px solid token(colors.greyscale.100)',
            backgroundColor: selectedCID === c.cid ? 'primary.100' : 'transparent',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          <button
            type="button"
            onClick={() => onSelect(c.cid)}
            className={css({
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              paddingX: '0.875rem',
              paddingY: '0.625rem',
              border: 'none',
              backgroundColor: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
            })}
            data-testid={`conv-item-${c.cid}`}
          >
            <Avatar name={nameOf(c)} size="2.25rem" />
            <span
              className={css({
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                minWidth: 0,
                fontWeight: c.unread_count > 0 ? 'bold' : 'normal',
                color: 'greyscale.900',
              })}
            >
              {mentionedCids?.has(c.cid) && (
                <span
                  aria-label={t('mention.notice')}
                  title={t('mention.notice')}
                  className={css({ flexShrink: 0, fontWeight: 'bold', fontSize: '0.8125rem' })}
                  style={{ color: '#dc2626' }}
                >
                  @
                </span>
              )}
              <span
                className={css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}
              >
                {nameOf(c)}
              </span>
            </span>
            {c.unread_count > 0 && (
              <span
                className={css({
                  flexShrink: 0,
                  paddingX: '0.5rem',
                  paddingY: '0.125rem',
                  borderRadius: '999px',
                  fontSize: '0.75rem',
                  backgroundColor: 'primary.500',
                  color: 'white',
                })}
              >
                {c.unread_count}
              </span>
            )}
          </button>
          <button
            type="button"
            data-role="del"
            onClick={() => onDelete(c)}
            title={t('actions.delete')}
            aria-label={t('actions.delete')}
            data-testid={`conv-del-${c.cid}`}
            className={css({
              flexShrink: 0,
              width: '2rem',
              border: 'none',
              backgroundColor: 'transparent',
              color: 'greyscale.500',
              fontSize: '1rem',
              lineHeight: 1,
              cursor: 'pointer',
              _hover: { color: '#dc2626' },
            })}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  )
}
