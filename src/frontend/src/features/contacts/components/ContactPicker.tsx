import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { Input, InteractiveListRow } from '@/primitives'

import { useDirectoryMemberSearch } from '../hooks/useDirectoryMemberSearch'
import type { DirectoryMember } from '../api/ApiDirectory'
import { MemberAvatar } from './MemberAvatar'

interface Props {
  /** Called with the chosen member. The caller closes the picker. */
  onSelect: (member: DirectoryMember) => void
  onClose: () => void
  includeSelf?: boolean
  title?: string
  searchPlaceholder?: string
}

/**
 * Modal directory picker: search org members by name/email and pick one. Used by
 * the IM "+ new conversation" flow — the chosen member's `id` is passed to the
 * backend as `peer_user_id`, which resolves the IM uid server-side.
 *
 * The caller themselves is filtered out by default. Flows such as task
 * assignment can opt in with `includeSelf` so the same picker also supports
 * assigning work back to the creator.
 */
export const ContactPicker = ({
  onSelect,
  onClose,
  includeSelf = false,
  title,
  searchPlaceholder,
}: Props) => {
  const { t } = useTranslation('contacts')
  const inputRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch({
    includeSelf,
  })
  const pickerTitle = title || t('picker.title')

  return (
    <Modal
      onClose={onClose}
      ariaLabel={pickerTitle}
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
          {pickerTitle}
        </h2>
        <ModalCloseButton onClose={onClose} label={t('picker.cancel')} />
      </div>

      <div className={css({ padding: '0.75rem 1rem' })}>
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder || t('picker.searchPlaceholder')}
          data-testid="contact-picker-search"
        />
      </div>

      <div className={css({ overflowY: 'auto', flex: 1 })}>
        {isFetching && selectable.length === 0 ? (
          <StateHint loading>{t('picker.loading')}</StateHint>
        ) : selectable.length === 0 ? (
          <StateHint>{t('picker.empty')}</StateHint>
        ) : (
          <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
            {selectable.map((member) => (
              <li key={member.id}>
                <InteractiveListRow
                  onClick={() => onSelect(member)}
                  data-testid={`contact-picker-item-${member.id}`}
                  divider
                >
                  <MemberAvatar
                    name={
                      member.full_name ||
                      member.short_name ||
                      member.email ||
                      ''
                    }
                    src={member.avatar_url}
                    size="2.25rem"
                  />
                  <span
                    className={css({
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.125rem',
                      minWidth: 0,
                    })}
                  >
                    <span
                      className={css({
                        fontWeight: 'medium',
                        color: 'greyscale.900',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {member.full_name || member.short_name || member.email}
                    </span>
                    <span
                      className={css({
                        fontSize: '0.75rem',
                        color: 'greyscale.500',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      })}
                    >
                      {[member.title, member.department?.name]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </InteractiveListRow>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
