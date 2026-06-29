import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import { announceLeave } from '../api/announceLeave'
import { updateGroupMeta } from '../api/updateGroupMeta'
import { Avatar } from './Avatar'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Called after the caller leaves the group (clears the open conversation). */
  onLeft: () => void
  onClose: () => void
}

/** Read the group description out of the conversation's free-form meta blob. */
const readDescription = (meta: unknown): string => {
  if (meta && typeof meta === 'object' && 'description' in meta) {
    const d = (meta as Record<string, unknown>).description
    if (typeof d === 'string') return d
  }
  return ''
}

/**
 * 群设置 — opened by clicking the group name. Holds the group-level settings:
 * rename + description (owner only), my group nickname / 免打扰 / @所有人不提示 /
 * 置顶 (every member, P10), 清空聊天记录, and leave. The roster lives in
 * {@link GroupMembersPanel}. Rendered as a fixed column below the chat header.
 */
export const GroupSettingsPanel = ({
  client,
  conversation,
  currentUserUID,
  onLeft,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const qc = useQueryClient()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const description = readDescription(conversation.meta)
  // Per-member settings come off the summary (P10).
  const pinned = !!conversation.pinned
  const muted = !!conversation.muted
  const muteAtAll = !!conversation.mute_at_all

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversation.name || '')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(description)
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const nickRef = useRef<HTMLInputElement>(null)
  const displayName = conversation.name || t('convName.groupFallback')

  // My own group nickname lives in the roster (listMembers carries nickname).
  const { data: roster = [] } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
    retry: false,
  })
  const myNickname =
    roster.find((m) => m.uid === currentUserUID)?.nickname ?? ''

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
  useEffect(() => {
    if (editingDesc) descRef.current?.focus()
  }, [editingDesc])
  useEffect(() => {
    if (editingNick) nickRef.current?.focus()
  }, [editingNick])

  const onError = (e: unknown) =>
    void showAlert({
      message: t('manage.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

  const saveName = async () => {
    const next = nameDraft.trim()
    if (!next || next === conversation.name) {
      setEditingName(false)
      return
    }
    setBusy(true)
    try {
      // Send full meta (preserve description) — jusi replaces meta wholesale.
      await updateGroupMeta(cid, { name: next, description, kind: 'rename' })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setEditingName(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const saveDescription = async () => {
    const next = descDraft.trim()
    if (next === description) {
      setEditingDesc(false)
      return
    }
    setBusy(true)
    try {
      await updateGroupMeta(cid, {
        name: conversation.name || '',
        description: next,
        kind: 'description',
      })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setEditingDesc(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const saveNickname = async () => {
    const next = nickDraft.trim()
    if (next === myNickname) {
      setEditingNick(false)
      return
    }
    setBusy(true)
    try {
      await client.setConversationSettings(cid, { nickname: next })
      // Roster carries nickname (drives my row + how others/messages render me).
      await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      setEditingNick(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  // pinned / muted / mute_at_all are private toggles surfaced on the summary;
  // flip then refresh the list (reorders pinned + re-reads the flags).
  const toggle = async (patch: {
    pinned?: boolean
    muted?: boolean
    mute_at_all?: boolean
  }) => {
    setBusy(true)
    try {
      await client.setConversationSettings(cid, patch)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const clearHistory = async () => {
    if (
      !(await askConfirm({
        message: t('manage.clearConfirm'),
        confirmLabel: t('manage.clear'),
        danger: true,
      }))
    )
      return
    setBusy(true)
    try {
      await client.clearHistory(cid)
      await qc.invalidateQueries({ queryKey: ['im', 'messages', cid] })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (
      !(await askConfirm({
        message: t('manage.leaveConfirm'),
        confirmLabel: t('manage.leave'),
        danger: true,
      }))
    )
      return
    setBusy(true)
    try {
      await announceLeave(cid).catch(() => {})
      await client.leaveConversation(cid)
      qc.removeQueries({ queryKey: ['im', 'members', cid] })
      onLeft()
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      onError(e)
      setBusy(false)
    }
  }

  const toggleRow = (
    label: string,
    checked: boolean,
    onChange: () => void,
    testid: string
  ): ReactNode => (
    <label
      className={css({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.625rem 1rem',
        borderBottom: '1px solid token(colors.greyscale.100)',
        cursor: 'pointer',
      })}
    >
      <span className={css({ fontSize: '0.875rem', color: 'greyscale.900' })}>
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={onChange}
        data-testid={testid}
        className={css({ width: '1rem', height: '1rem', cursor: 'pointer' })}
      />
    </label>
  )

  return (
    <aside
      aria-label={t('manage.settings')}
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
      {/* Header */}
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
          {t('manage.settings')}
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

      <div className={css({ flex: 1, overflowY: 'auto' })}>
        {/* Group identity: avatar + name (owner can rename inline) */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem',
            borderBottom: '1px solid token(colors.greyscale.100)',
          })}
        >
          <Avatar name={displayName} size="2.75rem" />
          {editingName ? (
            <div className={css({ display: 'flex', flex: 1, gap: '0.5rem' })}>
              <input
                ref={nameRef}
                type="text"
                value={nameDraft}
                maxLength={60}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={t('manage.renamePlaceholder')}
                data-testid="group-rename-input"
                className={inputCls}
              />
              <button
                type="button"
                disabled={busy}
                onClick={saveName}
                data-testid="group-rename-save"
                className={primaryBtn}
              >
                {t('manage.save')}
              </button>
            </div>
          ) : (
            <div
              className={css({
                display: 'flex',
                flex: 1,
                minWidth: 0,
                alignItems: 'center',
                gap: '0.5rem',
              })}
            >
              <span
                className={css({
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontWeight: 'medium',
                  color: 'greyscale.900',
                })}
              >
                {displayName}
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
                  className={editBtn}
                >
                  ✎
                </button>
              )}
            </div>
          )}
        </div>

        {/* Group description (owner edits; everyone reads) */}
        <div className={sectionCls}>
          <div className={sectionHead}>
            <span className={sectionLabel}>{t('manage.description')}</span>
            {isOwner && !editingDesc && (
              <button
                type="button"
                onClick={() => {
                  setDescDraft(description)
                  setEditingDesc(true)
                }}
                aria-label={t('manage.description')}
                data-testid="group-desc-edit"
                className={editBtn}
              >
                ✎
              </button>
            )}
          </div>
          {editingDesc ? (
            <div
              className={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              })}
            >
              <textarea
                ref={descRef}
                value={descDraft}
                maxLength={200}
                rows={3}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder={t('manage.descriptionPlaceholder')}
                data-testid="group-desc-input"
                className={css({
                  width: '100%',
                  resize: 'none',
                  paddingX: '0.625rem',
                  paddingY: '0.375rem',
                  border: '1px solid token(colors.greyscale.300)',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  outline: 'none',
                  _focus: { borderColor: 'primary.500' },
                })}
              />
              <div className={editActions}>
                <button
                  type="button"
                  onClick={() => setEditingDesc(false)}
                  className={ghostBtn}
                >
                  {t('manage.cancel')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={saveDescription}
                  data-testid="group-desc-save"
                  className={primaryBtn}
                >
                  {t('manage.save')}
                </button>
              </div>
            </div>
          ) : (
            <p
              className={css({
                margin: 0,
                fontSize: '0.875rem',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: description ? 'greyscale.800' : 'greyscale.400',
              })}
            >
              {description || t('manage.descriptionEmpty')}
            </p>
          )}
        </div>

        {/* My group nickname (every member edits their own) */}
        <div className={sectionCls}>
          <div className={sectionHead}>
            <span className={sectionLabel}>{t('manage.nickname')}</span>
            {!editingNick && (
              <button
                type="button"
                onClick={() => {
                  setNickDraft(myNickname)
                  setEditingNick(true)
                }}
                aria-label={t('manage.nickname')}
                data-testid="group-nick-edit"
                className={editBtn}
              >
                ✎
              </button>
            )}
          </div>
          {editingNick ? (
            <div className={css({ display: 'flex', gap: '0.5rem' })}>
              <input
                ref={nickRef}
                type="text"
                value={nickDraft}
                maxLength={60}
                onChange={(e) => setNickDraft(e.target.value)}
                placeholder={t('manage.nicknamePlaceholder')}
                data-testid="group-nick-input"
                className={inputCls}
              />
              <button
                type="button"
                disabled={busy}
                onClick={saveNickname}
                data-testid="group-nick-save"
                className={primaryBtn}
              >
                {t('manage.save')}
              </button>
            </div>
          ) : (
            <p
              className={css({
                margin: 0,
                fontSize: '0.875rem',
                color: myNickname ? 'greyscale.800' : 'greyscale.400',
              })}
            >
              {myNickname || t('manage.nicknameEmpty')}
            </p>
          )}
        </div>

        {/* Private toggles (P10) */}
        {toggleRow(
          t('manage.pin'),
          pinned,
          () => toggle({ pinned: !pinned }),
          'group-pin-toggle'
        )}
        {toggleRow(
          t('manage.mute'),
          muted,
          () => toggle({ muted: !muted }),
          'group-mute-toggle'
        )}
        {toggleRow(
          t('manage.muteAtAll'),
          muteAtAll,
          () => toggle({ mute_at_all: !muteAtAll }),
          'group-mute-all-toggle'
        )}

        {/* Clear history (per-member) */}
        <button
          type="button"
          disabled={busy}
          onClick={clearHistory}
          data-testid="group-clear"
          className={css({
            width: '100%',
            textAlign: 'left',
            padding: '0.625rem 1rem',
            border: 'none',
            borderBottom: '1px solid token(colors.greyscale.100)',
            backgroundColor: 'white',
            color: 'greyscale.900',
            fontSize: '0.875rem',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.50' },
          })}
        >
          {t('manage.clear')}
        </button>
      </div>

      {/* Footer: leave (every member) */}
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
            color: 'error.500',
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

const inputCls = css({
  flex: 1,
  minWidth: 0,
  paddingX: '0.625rem',
  paddingY: '0.375rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

const primaryBtn = css({
  paddingX: '0.75rem',
  border: 'none',
  borderRadius: '0.5rem',
  backgroundColor: 'primary.500',
  color: 'white',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})

const ghostBtn = css({
  paddingX: '0.75rem',
  paddingY: '0.25rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'white',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})

const editBtn = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  fontSize: '0.875rem',
  _hover: { color: 'primary.500' },
})

const sectionCls = css({
  padding: '0.875rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})

const sectionHead = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.375rem',
})

const sectionLabel = css({ fontSize: '0.8125rem', color: 'greyscale.600' })

const editActions = css({
  display: 'flex',
  gap: '0.5rem',
  justifyContent: 'flex-end',
})
