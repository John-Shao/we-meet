import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'

import { useDirectoryMemberSearch } from '../hooks/useDirectoryMemberSearch'
import type { DirectoryMember } from '../api/ApiDirectory'

interface Props {
  /** Called with the chosen member. The caller closes the picker. */
  onSelect: (member: DirectoryMember) => void
  onClose: () => void
}

/**
 * Modal directory picker: search org members by name/email and pick one. Used by
 * the IM "+ new conversation" flow — the chosen member's `id` is passed to the
 * backend as `peer_user_id`, which resolves the IM uid server-side.
 *
 * The caller themselves is filtered out (`is_self`) — you can't message yourself.
 */
export const ContactPicker = ({ onSelect, onClose }: Props) => {
  const { t } = useTranslation('contacts')
  const inputRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('picker.title')}
      initialFocusRef={inputRef}
      maxWidth="420px"
      maxHeight="70vh"
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('picker.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('picker.cancel')}
          className={css({
            border: 'none',
            background: 'transparent',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
            color: 'greyscale.600',
          })}
        >
          ×
        </button>
      </div>

      <div className={css({ padding: '0.75rem 1rem' })}>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('picker.searchPlaceholder')}
          data-testid="contact-picker-search"
          className={css({
            width: '100%',
            paddingX: '0.75rem',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            outline: 'none',
            _focus: { borderColor: 'primary.500' },
          })}
        />
      </div>

      <div className={css({ overflowY: 'auto', flex: 1 })}>
        {isFetching && selectable.length === 0 ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('picker.loading')}
          </p>
        ) : selectable.length === 0 ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('picker.empty')}
          </p>
        ) : (
          <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
            {selectable.map((member) => (
              <li key={member.id}>
                <button
                  type="button"
                  onClick={() => onSelect(member)}
                  data-testid={`contact-picker-item-${member.id}`}
                  className={css({
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.125rem',
                    width: '100%',
                    paddingX: '1rem',
                    paddingY: '0.625rem',
                    border: 'none',
                    borderBottom: '1px solid token(colors.greyscale.100)',
                    backgroundColor: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'greyscale.100' },
                  })}
                >
                  <span
                    className={css({
                      fontWeight: 'medium',
                      color: 'greyscale.900',
                    })}
                  >
                    {member.full_name || member.short_name || member.email}
                  </span>
                  <span
                    className={css({
                      fontSize: '0.75rem',
                      color: 'greyscale.500',
                    })}
                  >
                    {[member.title, member.department?.name]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
