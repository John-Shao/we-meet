import { useTranslation } from 'react-i18next'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

interface Props {
  conversations: ConversationSummary[]
  selectedCID: string | null
  onSelect: (cid: string) => void
  loading?: boolean
}

export const ConversationList = ({
  conversations,
  selectedCID,
  onSelect,
  loading,
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
        <li key={c.cid}>
          <button
            type="button"
            onClick={() => onSelect(c.cid)}
            className={css({
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingX: '1rem',
              paddingY: '0.75rem',
              border: 'none',
              borderBottom: '1px solid token(colors.greyscale.100)',
              cursor: 'pointer',
              textAlign: 'left',
              backgroundColor:
                selectedCID === c.cid ? 'primary.100' : 'transparent',
              _hover: { backgroundColor: 'greyscale.100' },
            })}
            data-testid={`conv-item-${c.cid}`}
          >
            <span
              className={css({
                fontWeight: c.unread_count > 0 ? 'bold' : 'normal',
                color: 'greyscale.900',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {c.cid}
            </span>
            {c.unread_count > 0 && (
              <span
                className={css({
                  marginLeft: '0.5rem',
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
        </li>
      ))}
    </ul>
  )
}
