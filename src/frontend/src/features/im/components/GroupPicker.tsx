import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css, cx } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { fetchDirectoryMembers } from '@/features/contacts'

/**
 * Modal directory picker for creating a GROUP conversation (对标飞书):
 * the creator (self) is always selected and locked; other org members are
 * toggled on the left and shown as removable chips on the right. The chosen
 * member ids (excluding self — the backend adds the owner automatically) are
 * passed to `onCreate` along with an optional group name.
 */
interface Props {
  onCreate: (memberUserIds: string[], name: string) => void
  onClose: () => void
}

export const GroupPicker = ({ onCreate, onClose }: Props) => {
  const { t } = useTranslation('im')
  const { user } = useUser()
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  // id → display label, captured at toggle time so chips stay labelled even
  // after the search query (and thus the visible member list) changes.
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const searchRef = useRef<HTMLInputElement>(null)

  const selfLabel = user?.full_name || user?.email || t('group.you')

  useEffect(() => {
    searchRef.current?.focus()
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

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate = selected.size > 0
  // count includes self (locked).
  const total = selected.size + 1

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
          maxWidth: '640px',
          maxHeight: '72vh',
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
          <h2 className={css({ margin: 0, fontSize: '1rem', fontWeight: 'bold', color: 'greyscale.900' })}>
            {t('group.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('group.cancel')}
            className={css({ border: 'none', background: 'transparent', fontSize: '1.25rem', lineHeight: 1, cursor: 'pointer', color: 'greyscale.600' })}
          >
            ×
          </button>
        </div>

        {/* Two columns: left = search + member list, right = 已选 panel */}
        <div className={css({ display: 'flex', flex: 1, minHeight: 0 })}>
          <div
            className={css({
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minWidth: 0,
              borderRight: '1px solid token(colors.greyscale.200)',
            })}
          >
            <div className={css({ padding: '0.75rem 1rem' })}>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('group.searchPlaceholder')}
                data-testid="group-picker-search"
                className={inputCls}
              />
            </div>
            <div className={css({ overflowY: 'auto', flex: 1 })}>
              {/* self — locked, always selected */}
              <Row label={selfLabel} sub={t('group.you')} checked disabled />
              {isFetching && selectable.length === 0 ? (
                <p className={css({ padding: '1rem', color: 'greyscale.500' })}>{t('group.loading')}</p>
              ) : (
                selectable.map((m) => (
                  <Row
                    key={m.id}
                    testid={`group-picker-item-${m.id}`}
                    label={m.full_name || m.short_name || m.email || m.id}
                    sub={[m.title, m.department?.name].filter(Boolean).join(' · ')}
                    checked={selected.has(m.id)}
                    onToggle={() =>
                      toggle(m.id, m.full_name || m.short_name || m.email || m.id)
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className={css({ width: '40%', display: 'flex', flexDirection: 'column', minWidth: 0 })}>
            <div className={css({ padding: '0.75rem 1rem 0.25rem', fontSize: '0.8125rem', color: 'greyscale.600' })}>
              {t('group.selected', { count: total })}
            </div>
            <ul className={css({ listStyle: 'none', margin: 0, padding: '0 0.5rem', overflowY: 'auto', flex: 1 })}>
              <Chip label={selfLabel} />
              {[...selected.entries()].map(([id, label]) => (
                <Chip key={id} label={label} onRemove={() => toggle(id, label)} />
              ))}
            </ul>
          </div>
        </div>

        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            paddingX: '1rem',
            paddingY: '0.75rem',
            borderTop: '1px solid token(colors.greyscale.200)',
          })}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('group.namePlaceholder')}
            data-testid="group-picker-name"
            className={cx(inputCls, css({ flex: 1, minWidth: 0 }))}
          />
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => onCreate([...selected.keys()], name.trim())}
            data-testid="group-picker-create"
            className={css({
              flexShrink: 0,
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

const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

const Row = ({
  label,
  sub,
  checked,
  disabled,
  onToggle,
  testid,
}: {
  label: string
  sub?: string
  checked?: boolean
  disabled?: boolean
  onToggle?: () => void
  testid?: string
}) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={disabled}
    aria-pressed={checked}
    data-testid={testid}
    className={css({
      display: 'flex',
      alignItems: 'center',
      gap: '0.625rem',
      width: '100%',
      paddingX: '1rem',
      paddingY: '0.5rem',
      border: 'none',
      borderBottom: '1px solid token(colors.greyscale.100)',
      backgroundColor: checked ? 'greyscale.100' : 'transparent',
      textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      _hover: { backgroundColor: disabled ? undefined : 'greyscale.100' },
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
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 })}>
      <span className={css({ fontWeight: 'medium', color: 'greyscale.900', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>
        {label}
      </span>
      {sub ? <span className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>{sub}</span> : null}
    </span>
  </button>
)

const Chip = ({ label, onRemove }: { label: string; onRemove?: () => void }) => (
  <li
    className={css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.5rem',
      paddingX: '0.5rem',
      paddingY: '0.375rem',
      borderRadius: '0.375rem',
      _hover: { backgroundColor: 'greyscale.50' },
    })}
  >
    <span className={css({ fontSize: '0.8125rem', color: 'greyscale.800', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>
      {label}
    </span>
    {onRemove ? (
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove"
        className={css({ flexShrink: 0, border: 'none', background: 'transparent', color: 'greyscale.500', cursor: 'pointer', fontSize: '0.875rem', _hover: { color: 'error.500' } })}
      >
        ×
      </button>
    ) : null}
  </li>
)
