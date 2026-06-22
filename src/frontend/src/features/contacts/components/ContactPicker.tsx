import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'

import { fetchDirectoryMembers } from '../api/fetchDirectoryMembers'
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
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the search field on open and wire Escape-to-close (keyboard a11y for
  // the backdrop, which only handles pointer dismiss).
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: members = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', query],
    queryFn: () => fetchDirectoryMembers(query),
    staleTime: 30_000,
  })
  const selectable = members.filter((m) => !m.is_self)

  return (
    // Backdrop click dismisses only when the click lands on the backdrop itself
    // (not bubbled from the card), so the card needs no handler of its own.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={css({
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        padding: '1rem',
      })}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('picker.title')}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: '420px',
          maxHeight: '70vh',
          backgroundColor: 'white',
          borderRadius: '0.75rem',
          overflow: 'hidden',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        })}
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
      </div>
    </div>
  )
}
