import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import { Avatar } from './Avatar'

interface Props {
  client: Client
  conversation: ConversationSummary
  /** Peer display name, resolved upstream. */
  peerName: string
  /** Peer uploaded avatar URL (presigned); undefined → tinted initial. */
  peerAvatarUrl?: string
  /** Open group creation seeded with this peer (对标飞书「创建群组」). */
  onCreateGroup: () => void
  onClose: () => void
}

/**
 * 一对一会话设置(对标飞书):创建群组 + 消息免打扰 / 置顶会话(P10 私有开关)+
 * 清空聊天记录。群相关项(改名/成员/退群)不适用 direct,见 {@link GroupSettingsPanel}。
 * 以 chat header 右侧固定列呈现,与群设置同位。
 */
export const DirectSettingsPanel = ({
  client,
  conversation,
  peerName,
  peerAvatarUrl,
  onCreateGroup,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const qc = useQueryClient()
  const cid = conversation.cid
  const pinned = !!conversation.pinned
  const muted = !!conversation.muted
  const [busy, setBusy] = useState(false)

  const onError = (e: unknown) =>
    void showAlert({
      message: t('manage.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

  const toggle = async (patch: { pinned?: boolean; muted?: boolean }) => {
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
        {/* Peer identity */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem',
            borderBottom: '1px solid token(colors.greyscale.100)',
          })}
        >
          <Avatar name={peerName} src={peerAvatarUrl} size="2.75rem" />
          <span
            className={css({
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 'medium',
              color: 'greyscale.900',
            })}
          >
            {peerName}
          </span>
        </div>

        {/* 创建群组(带上对方) */}
        <button
          type="button"
          disabled={busy}
          onClick={onCreateGroup}
          data-testid="direct-create-group"
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
          {t('group.button')}
        </button>

        {/* Private toggles (P10) */}
        {toggleRow(
          t('manage.pin'),
          pinned,
          () => toggle({ pinned: !pinned }),
          'direct-pin-toggle'
        )}
        {toggleRow(
          t('manage.mute'),
          muted,
          () => toggle({ muted: !muted }),
          'direct-mute-toggle'
        )}

        {/* Clear history (per-member) */}
        <button
          type="button"
          disabled={busy}
          onClick={clearHistory}
          data-testid="direct-clear"
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
    </aside>
  )
}
