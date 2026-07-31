import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { fetchDirectoryMembers, MemberAvatar } from '@/features/contacts'
import { useConfirm } from '@/components/ConfirmProvider'

import { addMembers } from '../api/addMembers'
import { resolveImUsers } from '../api/resolveImUsers'

/**
 * Add members to an EXISTING group (对标飞书「添加群成员」): people already in
 * the group are shown checked + disabled; only new members are selectable.
 */
interface Props {
  client: Client
  cid: string
  onClose: () => void
}

export const AddMemberDialog = ({ client, cid, onClose }: Props) => {
  const { t } = useTranslation('im')
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { alert: showAlert } = useConfirm()
  const searchRef = useRef<HTMLInputElement>(null)

  // Current roster → resolve to we-meet ids so we can lock existing members.
  const { data: roster = [] } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
  })
  const rosterUids = roster.map((m) => m.uid)
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', rosterUids],
    queryFn: () => resolveImUsers(rosterUids),
    enabled: rosterUids.length > 0,
    staleTime: 60_000,
  })
  const existingIds = new Set(Object.values(names).map((n) => n.id))

  const { data: dir = [], isFetching } = useQuery({
    queryKey: ['directory', 'members', query],
    queryFn: () => fetchDirectoryMembers(query),
    staleTime: 30_000,
  })
  const selectable = dir.filter((m) => !m.is_self)

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const canAdd = selected.size > 0 && !busy
  const confirm = async () => {
    setBusy(true)
    try {
      await addMembers(cid, [...selected])
      await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      onClose()
    } catch (e) {
      void showAlert({ message: t('manage.error', { message: e instanceof Error ? e.message : String(e) }) })
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('manage.addTitle')}
      maxWidth="440px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <div className={modalHead}>
          <h2 className={css({ margin: 0, fontSize: '1rem', fontWeight: 'bold', color: 'greyscale.900' })}>
            {t('manage.addTitle')}
          </h2>
          <ModalCloseButton onClose={onClose} label={t('manage.cancel')} />
        </div>
        <div className={css({ padding: '0.75rem 1rem' })}>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('group.searchPlaceholder')}
            data-testid="add-member-search"
            className={inputCls}
          />
        </div>
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {isFetching && selectable.length === 0 ? (
            <StateHint loading>{t('group.loading')}</StateHint>
          ) : selectable.length === 0 ? (
            <StateHint>{t('manage.empty')}</StateHint>
          ) : (
            <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
              {selectable.map((m) => {
                const already = existingIds.has(m.id)
                const checked = already || selected.has(m.id)
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => toggle(m.id)}
                      aria-pressed={checked}
                      data-testid={`add-member-item-${m.id}`}
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
                        cursor: already ? 'default' : 'pointer',
                        opacity: already ? 0.55 : 1,
                        _hover: { backgroundColor: already ? undefined : 'greyscale.100' },
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
                      <MemberAvatar
                        name={m.full_name || m.short_name || m.email || m.id}
                        src={m.avatar_url}
                        size="2rem"
                      />
                      <span className={css({ display: 'flex', flexDirection: 'column', minWidth: 0 })}>
                        <span className={css({ fontWeight: 'medium', color: 'greyscale.900', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>
                          {m.full_name || m.short_name || m.email || m.id}
                        </span>
                        <span className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>
                          {[m.title, m.department?.name].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className={modalFoot}>
          <span className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
            {t('group.selected', { count: selected.size })}
          </span>
          <Button
            variant="primary"
            size="action"
            isDisabled={!canAdd}
            onPress={confirm}
            data-testid="add-member-confirm"
          >
            {busy ? t('input.sending') : t('manage.addMembers')}
          </Button>
        </div>
    </Modal>
  )
}

const modalHead = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const modalFoot = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
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
