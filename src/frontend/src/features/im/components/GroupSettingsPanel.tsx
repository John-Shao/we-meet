import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { announceLeave } from '../api/announceLeave'
import { renameGroup } from '../api/renameGroup'
import { Avatar } from './Avatar'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Called after the caller leaves the group (clears the open conversation). */
  onLeft: () => void
  onClose: () => void
}

/**
 * 群设置 — opened by clicking the group name. Holds the group-level actions:
 * rename (owner only) and leave (every member). The roster lives in
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
  const qc = useQueryClient()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversation.name || '')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const displayName = conversation.name || t('convName.groupFallback')

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
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setEditingName(false)
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
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      <div className={css({ flex: 1 })} />

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
