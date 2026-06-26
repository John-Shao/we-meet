import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { announceLeave } from '../api/announceLeave'
import { removeMember } from '../api/removeMember'
import { renameGroup } from '../api/renameGroup'
import { resolveImUsers } from '../api/resolveImUsers'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Open the add-members picker. */
  onAddMembers: () => void
  /** Called after the caller leaves the group (clears the open conversation). */
  onLeft: () => void
  onClose: () => void
}

const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#16a34a',
  '#0891b2',
]
const tintFor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const initial = (s: string): string => (s.trim()[0] || '?').toUpperCase()

export const GroupInfoPanel = ({
  client,
  conversation,
  currentUserUID,
  onAddMembers,
  onLeft,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const qc = useQueryClient()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversation.name || '')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (editingName) nameRef.current?.focus()
  }, [editingName])

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

  const saveName = async () => {
    const next = nameDraft.trim()
    if (!next || next === conversation.name) {
      setEditingName(false)
      return
    }
    setBusy(true)
    try {
      await renameGroup(cid, next)
      await refresh()
      setEditingName(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

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

  const leave = async () => {
    if (!window.confirm(t('manage.leaveConfirm'))) return
    setBusy(true)
    try {
      // Announce "X 退出群聊" while still a member (best-effort), then leave.
      await announceLeave(cid).catch(() => {})
      await client.leaveConversation(cid)
      // Drop the now-inaccessible roster query so nothing refetches it (→403),
      // close + clear selection immediately, then refresh only the list.
      qc.removeQueries({ queryKey: ['im', 'members', cid] })
      onLeft()
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      onError(e)
      setBusy(false)
    }
  }

  return (
    // A fixed third column (peer of the conversation list), not a floating
    // overlay — matches Feishu's persistent group-info panel.
    <aside
      aria-label={t('manage.info')}
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
          {t('manage.info')}
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

      {/* Group name (owner can rename inline) */}
      <div
        className={css({
          padding: '0.75rem 1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
      >
        {editingName ? (
          <div className={css({ display: 'flex', gap: '0.5rem' })}>
            <input
              ref={nameRef}
              type="text"
              value={nameDraft}
              maxLength={60}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={t('manage.renamePlaceholder')}
              data-testid="group-rename-input"
              className={css({
                flex: 1,
                minWidth: 0,
                paddingX: '0.625rem',
                paddingY: '0.375rem',
                border: '1px solid token(colors.greyscale.300)',
                borderRadius: '0.5rem',
                fontSize: '0.875rem',
                outline: 'none',
                _focus: { borderColor: 'primary.500' },
              })}
            />
            <button
              type="button"
              disabled={busy}
              onClick={saveName}
              data-testid="group-rename-save"
              className={css({
                paddingX: '0.75rem',
                border: 'none',
                borderRadius: '0.5rem',
                backgroundColor: 'primary.500',
                color: 'white',
                fontSize: '0.8125rem',
                cursor: 'pointer',
              })}
            >
              {t('manage.save')}
            </button>
          </div>
        ) : (
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            })}
          >
            <span
              className={css({ fontWeight: 'medium', color: 'greyscale.900' })}
            >
              {conversation.name || t('convName.groupFallback')}
            </span>
            {isOwner && (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(conversation.name || '')
                  setEditingName(true)
                }}
                title={t('manage.rename')}
                aria-label={t('manage.rename')}
                data-testid="group-rename"
                className={css({
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: 'greyscale.500',
                  fontSize: '0.875rem',
                  _hover: { color: 'primary.500' },
                })}
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      {/* Members header + add */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingTop: '0.625rem',
        })}
      >
        <span
          className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}
        >
          {t('manage.members')} ·{' '}
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
                <span
                  aria-hidden="true"
                  className={css({
                    flexShrink: 0,
                    width: '2rem',
                    height: '2rem',
                    borderRadius: '999px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontSize: '0.8125rem',
                    fontWeight: 'bold',
                  })}
                  style={{ backgroundColor: tintFor(label) }}
                >
                  {initial(label)}
                </span>
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

      {/* Footer: leave */}
      <div
        className={css({
          padding: '0.75rem 1rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
        <button
          type="button"
          disabled={busy}
          onClick={leave}
          data-testid="group-leave"
          className={css({
            width: '100%',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            backgroundColor: 'white',
            color: '#dc2626',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.50' },
          })}
        >
          {t('manage.leave')}
        </button>
      </div>
    </aside>
  )
}
