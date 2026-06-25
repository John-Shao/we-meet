import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { fetchDirectoryMembers } from '@/features/contacts'

/**
 * Modal directory picker for creating a GROUP conversation: search org members,
 * toggle several of them, give the group an optional name, then create.
 *
 * Mirrors {@link ContactPicker} (single-select) but keeps a selection set — kept
 * as a separate component so ContactPicker's single-select `onSelect` contract is
 * untouched. The chosen member ids are passed to the backend as `member_user_ids`,
 * which resolves each IM uid server-side.
 */
interface Props {
  /** Called with the chosen member ids + group name. The caller closes the picker. */
  onCreate: (memberUserIds: string[], name: string) => void
  onClose: () => void
}

export const GroupPicker = ({ onCreate, onClose }: Props) => {
  const { t } = useTranslation('im')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

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

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const canCreate = selected.size > 0

  return (
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
        aria-label={t('group.title')}
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
            {t('group.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('group.cancel')}
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

        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            padding: '0.75rem 1rem',
          })}
        >
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('group.namePlaceholder')}
            data-testid="group-picker-name"
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
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('group.searchPlaceholder')}
            data-testid="group-picker-search"
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
              {t('group.loading')}
            </p>
          ) : selectable.length === 0 ? (
            <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
              {t('group.empty')}
            </p>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {selectable.map((member) => {
                const checked = selected.has(member.id)
                return (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => toggle(member.id)}
                      aria-pressed={checked}
                      data-testid={`group-picker-item-${member.id}`}
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.625rem',
                        width: '100%',
                        paddingX: '1rem',
                        paddingY: '0.625rem',
                        border: 'none',
                        borderBottom: '1px solid token(colors.greyscale.100)',
                        backgroundColor: checked ? 'greyscale.100' : 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                        _hover: { backgroundColor: 'greyscale.100' },
                      })}
                    >
                      <span
                        aria-hidden="true"
                        className={css({
                          flexShrink: 0,
                          width: '1.125rem',
                          height: '1.125rem',
                          borderRadius: '0.25rem',
                          border: '1px solid token(colors.greyscale.400)',
                          backgroundColor: checked ? 'primary.500' : 'white',
                          color: 'white',
                          fontSize: '0.75rem',
                          lineHeight: '1.125rem',
                          textAlign: 'center',
                        })}
                      >
                        {checked ? '✓' : ''}
                      </span>
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
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            paddingX: '1rem',
            paddingY: '0.75rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          <span className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
            {t('group.selected', { count: selected.size })}
          </span>
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => onCreate([...selected], name.trim())}
            data-testid="group-picker-create"
            className={css({
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '0.5rem',
              backgroundColor: canCreate ? 'primary.500' : 'greyscale.300',
              color: 'white',
              fontSize: '0.875rem',
              fontWeight: 'medium',
              cursor: canCreate ? 'pointer' : 'not-allowed',
            })}
          >
            {t('group.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
