import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { removeMember } from '../api/removeMember'
import { resolveImUsers } from '../api/resolveImUsers'
import { Avatar } from './Avatar'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Open the add-members picker. */
  onAddMembers: () => void
  onClose: () => void
}

/**
 * 群成员 — the group roster (member list, owner badge, transfer/kick/add).
 * Rename + leave live in {@link GroupSettingsPanel}; this panel is read +
 * member-management only. Rendered as a fixed column below the chat header.
 */
export const GroupMembersPanel = ({
  client,
  conversation,
  currentUserUID,
  onAddMembers,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const qc = useQueryClient()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The roster is its own REST query; a conv lifecycle event for this group
  // (someone joined / left / was removed) only refreshes the conversation list,
  // not this query — so without invalidating here the open panel stays stale
  // until reopened. Refetch the roster whenever this conversation changes.
  useEffect(() => {
    const off = client.onConversation((ev) => {
      if (ev.cid === cid) {
        void qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      }
    })
    return off
  }, [client, cid, qc])

  const { data: roster = [], isLoading } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
    // Never retry: a 403 (you left / were removed) won't succeed on retry, and
    // the default 3× backoff would freeze the UI ~5s after leaving the group.
    retry: false,
  })
  const rosterUids = roster.map((m) => m.uid)
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', rosterUids],
    queryFn: () => resolveImUsers(rosterUids),
    enabled: rosterUids.length > 0,
    staleTime: 60_000,
  })
  const nameOf = (uid: string) => names[uid]?.full_name || uid

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
    await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
  }

  const onError = (e: unknown) =>
    window.alert(
      t('manage.error', { message: e instanceof Error ? e.message : String(e) })
    )

  const kick = async (uid: string) => {
    const userId = names[uid]?.id
    if (!userId) return
    if (!window.confirm(t('manage.removeConfirm', { name: nameOf(uid) })))
      return
    setBusy(true)
    try {
      await removeMember(cid, userId)
      await refresh()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const transfer = async (uid: string) => {
    if (!window.confirm(t('manage.transferConfirm', { name: nameOf(uid) })))
      return
    setBusy(true)
    try {
      await client.transferOwner(cid, uid)
      await refresh()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      aria-label={t('manage.membersTitle')}
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        width: '300px',
        height: '100%',
        backgroundColor: 'white',
        borderLeft: '1px solid token(colors.greyscale.200)',
        overflow: 'hidden',
        animation: 'fade 150ms ease-out',
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
          {t('manage.membersTitle')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('manage.cancel')}
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

      {/* Members header + add */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingTop: '0.75rem',
        })}
      >
        <span
          className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}
        >
          {t('header.memberCount', { count: roster.length })}
        </span>
        <button
          type="button"
          onClick={onAddMembers}
          data-testid="group-info-add"
          className={css({
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '999px',
            backgroundColor: 'white',
            width: '1.5rem',
            height: '1.5rem',
            cursor: 'pointer',
            color: 'greyscale.700',
            fontSize: '0.875rem',
            lineHeight: 1,
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          ＋
        </button>
      </div>

      {/* Roster */}
      <ul
        className={css({
          listStyle: 'none',
          margin: 0,
          padding: '0.5rem 0',
          overflowY: 'auto',
          flex: 1,
        })}
      >
        {isLoading ? (
          <li
            className={css({ padding: '0.5rem 1rem', color: 'greyscale.500' })}
          >
            {t('group.loading')}
          </li>
        ) : (
          roster.map((m) => {
            const label = nameOf(m.uid)
            const isSelf = m.uid === currentUserUID
            // Drive the badge off owner_uid (authoritative) rather than the
            // roster role, which can lag a transfer until the row re-syncs.
            const isRowOwner = m.uid === conversation.owner_uid
            const canActOnRow = isOwner && !isSelf && !isRowOwner
            return (
              <li
                key={m.uid}
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.625rem',
                  paddingX: '1rem',
                  paddingY: '0.375rem',
                  _hover: { backgroundColor: 'greyscale.50' },
                })}
              >
                <Avatar name={label} size="2rem" />
                <span
                  className={css({
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'greyscale.900',
                  })}
                >
                  {label}
                </span>
                {isRowOwner && (
                  <span
                    className={css({
                      flexShrink: 0,
                      fontSize: '0.6875rem',
                      borderRadius: '0.25rem',
                      paddingX: '0.25rem',
                    })}
                    style={{ color: '#2563eb', border: '1px solid #bfdbfe' }}
                  >
                    {t('manage.owner')}
                  </span>
                )}
                {canActOnRow && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => transfer(m.uid)}
                      title={t('manage.transfer')}
                      aria-label={t('manage.transfer')}
                      data-testid={`member-transfer-${m.uid}`}
                      className={css({
                        flexShrink: 0,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'greyscale.500',
                        fontSize: '0.875rem',
                        _hover: { color: 'primary.500' },
                      })}
                    >
                      ♛
                    </button>
                    <button
                      type="button"
                      disabled={busy || !names[m.uid]?.id}
                      onClick={() => kick(m.uid)}
                      title={t('manage.remove')}
                      aria-label={t('manage.remove')}
                      data-testid={`member-kick-${m.uid}`}
                      className={css({
                        flexShrink: 0,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'greyscale.500',
                        fontSize: '0.875rem',
                        _hover: { color: '#dc2626' },
                      })}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            )
          })
        )}
      </ul>
    </aside>
  )
}
