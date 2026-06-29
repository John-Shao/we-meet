import { useTranslation } from 'react-i18next'
import { RiCloseLine, RiMessage3Line } from '@remixicon/react'

import { css } from '@/styled-system/css'
import type { DirectoryMember } from '../api/ApiDirectory'

/**
 * Feishu-style member detail panel — the right column of 通讯录. Clicking a
 * member row opens this card (avatar / name / org info) with a "发消息" action
 * that starts a direct IM conversation. Closing returns to the member list only.
 */

interface Props {
  member: DirectoryMember
  onMessage: (member: DirectoryMember) => void
  onClose: () => void
}

export const MemberDetailPanel = ({ member, onMessage, onClose }: Props) => {
  const { t } = useTranslation('contacts')
  const name = member.full_name || member.short_name || member.email || ''
  const initial = (name || '?').slice(0, 1).toUpperCase()
  const dash = t('detail.none')

  return (
    <aside
      className={css({
        flexShrink: 0,
        width: '300px',
        height: '100%',
        borderLeft: '1px solid token(colors.greyscale.200)',
        backgroundColor: 'white',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      })}
      data-testid="member-detail"
    >
      <div
        className={css({
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '0.5rem',
        })}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('detail.close')}
          className={css({
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'greyscale.500',
            borderRadius: '6px',
            padding: '0.25rem',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      {/* Identity */}
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.5rem',
          paddingX: '1.25rem',
          paddingBottom: '1rem',
          textAlign: 'center',
        })}
      >
        {member.avatar_url ? (
          <img
            src={member.avatar_url}
            alt={name}
            className={css({
              width: '72px',
              height: '72px',
              borderRadius: 'full',
              objectFit: 'cover',
            })}
          />
        ) : (
          <span
            className={css({
              width: '72px',
              height: '72px',
              borderRadius: 'full',
              backgroundColor: 'primary.500',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.75rem',
            })}
          >
            {initial}
          </span>
        )}
        <span
          className={css({
            fontSize: '1.0625rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {name}
          {member.is_self && (
            <span className={css({ color: 'greyscale.400', fontWeight: 'normal' })}>
              {' '}
              {t('page.selfTag')}
            </span>
          )}
        </span>
        {member.title && (
          <span className={css({ fontSize: '0.8125rem', color: 'greyscale.500' })}>
            {member.title}
          </span>
        )}
      </div>

      {/* Info rows */}
      <dl
        className={css({
          margin: 0,
          paddingX: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.875rem',
        })}
      >
        <InfoRow label={t('detail.department')} value={member.department?.name || dash} />
        <InfoRow label={t('detail.title')} value={member.title || dash} />
        <InfoRow label={t('detail.email')} value={member.email || dash} />
      </dl>

      {!member.is_self && (
        <div className={css({ marginTop: 'auto', padding: '1.25rem' })}>
          <button
            type="button"
            onClick={() => onMessage(member)}
            data-testid={`member-detail-message-${member.id}`}
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: 'primary.500',
              color: 'white',
              paddingY: '0.625rem',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: 'pointer',
              _hover: { backgroundColor: 'primary.600' },
            })}
          >
            <RiMessage3Line size={18} />
            {t('page.message')}
          </button>
        </div>
      )}
    </aside>
  )
}

const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className={css({ display: 'flex', flexDirection: 'column', gap: '0.125rem' })}>
    <dt className={css({ fontSize: '0.75rem', color: 'greyscale.400' })}>{label}</dt>
    <dd
      className={css({
        margin: 0,
        fontSize: '0.875rem',
        color: 'greyscale.800',
        wordBreak: 'break-all',
      })}
    >
      {value}
    </dd>
  </div>
)
