import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

import { resolveImUsers } from '../api/resolveImUsers'
import { MessageInput } from '../components/MessageInput'
import { MessageItem } from '../components/MessageItem'
import { useMessages } from '../hooks/useMessages'

interface Props {
  client: Client
  conversation: ConversationSummary
  /** Display title resolved upstream (group name / direct peer name). */
  title: string
  currentUserUID: string
  sendDisabled: boolean
  /** Toggle the 群成员 (member roster) panel — the ⋯ button (group only). */
  onOpenInfo?: () => void
  /** Toggle the 群设置 panel — clicking the group name (group only). */
  onOpenSettings?: () => void
  /** Open the add-members picker (group only). */
  onAddMembers?: () => void
  /** Group info / member side panel; rendered to the right of the message
   * stream, below the header (Feishu-style). Null when collapsed. */
  infoPanel?: ReactNode
}

export const ChatPane = ({
  client,
  conversation,
  title,
  currentUserUID,
  sendDisabled,
  onOpenInfo,
  onOpenSettings,
  onAddMembers,
  infoPanel,
}: Props) => {
  const { t } = useTranslation('im')
  const cid = conversation.cid
  const isGroup = conversation.type === 'group'
  const { data: messages = [], isLoading } = useMessages(client, cid)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Resolve member uids → display names so group messages show names, not uids.
  const memberUids = conversation.members
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: isGroup && memberUids.length > 0,
    staleTime: 60_000,
  })
  // P10 群昵称:the roster carries each member's per-group nickname, which
  // overrides their org-directory name within THIS conversation.
  const { data: roster = [] } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    enabled: isGroup,
    staleTime: 30_000,
    retry: false,
  })
  const nickOf = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of roster) if (r.nickname) m[r.uid] = r.nickname
    return m
  }, [roster])
  // For a sender's display: nickname → directory name → uid.
  const nameOf = useMemo(
    () => (uid: string) => nickOf[uid] || names[uid]?.full_name || uid,
    [nickOf, names]
  )
  // For @-matching: a real resolved display only (no bare-uid fallback).
  const displayOf = (uid: string): string | undefined =>
    nickOf[uid] || names[uid]?.full_name
  const everyone = t('mention.everyone')
  const selfName = displayOf(currentUserUID) || ''
  // Names highlightable in message bodies: 所有人 + every member (incl. self).
  const highlightNames = useMemo(
    () =>
      isGroup
        ? [
            everyone,
            ...memberUids
              .map((u) => nickOf[u] || names[u]?.full_name)
              .filter((n): n is string => !!n),
          ]
        : [],
    [isGroup, everyone, memberUids, names, nickOf]
  )
  // @-mention dropdown suggestions: 所有人 + other members (not yourself).
  const mentionables = useMemo(
    () =>
      isGroup
        ? [
            everyone,
            ...memberUids
              .filter((u) => u !== currentUserUID)
              .map((u) => nickOf[u] || names[u]?.full_name)
              .filter((n): n is string => !!n),
          ]
        : [],
    [isGroup, everyone, memberUids, names, nickOf, currentUserUID]
  )

  // Auto-scroll on new message.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages.length])

  // Mark the latest seq read whenever we render a non-empty view.
  useEffect(() => {
    if (messages.length === 0) return
    const latest = messages[messages.length - 1]
    if (latest && latest.seq > 0) {
      void client.markRead(cid, latest.seq).catch(() => {
        // best-effort; the marker will catch up on the next render
      })
    }
  }, [client, cid, messages])

  const onSend = async (text: string) => {
    await client.sendText(cid, text)
  }

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
      })}
    >
      {/* Header: title + (group) member count + actions */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingX: '1rem',
          paddingY: '0.625rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
          minHeight: '3rem',
        })}
      >
        <div className={css({ flex: 1, minWidth: 0 })}>
          {onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              title={t('manage.settings')}
              data-testid="chat-group-title"
              className={css({
                display: 'block',
                maxWidth: '100%',
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontWeight: 'bold',
                color: 'greyscale.900',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                _hover: { color: 'primary.500' },
              })}
            >
              {title}
            </button>
          ) : (
            <div
              className={css({
                fontWeight: 'bold',
                color: 'greyscale.900',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {title}
            </div>
          )}
          {isGroup && (
            <div
              className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
            >
              {t('header.memberCount', { count: memberUids.length })}
            </div>
          )}
        </div>
        {isGroup && onAddMembers && (
          <button
            type="button"
            onClick={onAddMembers}
            title={t('manage.addMembers')}
            aria-label={t('manage.addMembers')}
            data-testid="chat-add-members"
            className={headerBtn}
          >
            ＋
          </button>
        )}
        {isGroup && onOpenInfo && (
          <button
            type="button"
            onClick={onOpenInfo}
            title={t('manage.membersTitle')}
            aria-label={t('manage.membersTitle')}
            data-testid="chat-group-info"
            className={headerBtn}
          >
            ⋯
          </button>
        )}
        {!isGroup && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title={t('manage.settings')}
            aria-label={t('manage.settings')}
            data-testid="chat-direct-settings"
            className={headerBtn}
          >
            ⋯
          </button>
        )}
      </div>

      {/* Body: message stream (+ input) on the left, info panel on the right.
          Both sit below the full-width header, matching Feishu. */}
      <div
        className={css({
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        })}
      >
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
          })}
        >
          <div
            ref={scrollRef}
            className={css({
              flex: 1,
              overflowY: 'auto',
              paddingY: '0.5rem',
            })}
          >
            {isLoading ? (
              <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
                {t('chat.loading')}
              </div>
            ) : messages.length === 0 ? (
              <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
                {t('chat.empty')}
              </div>
            ) : (
              messages.map((m) => (
                <MessageItem
                  key={m.mid}
                  message={m}
                  isOwn={m.sender_uid === currentUserUID}
                  senderName={nameOf(m.sender_uid)}
                  senderAvatarUrl={names[m.sender_uid]?.avatar_url}
                  showSender={isGroup}
                  mentionNames={highlightNames}
                  selfMentionNames={[selfName, everyone].filter(Boolean)}
                />
              ))
            )}
          </div>
          <MessageInput
            onSend={onSend}
            disabled={sendDisabled}
            mentionables={mentionables}
          />
        </div>
        {infoPanel}
      </div>
    </div>
  )
}

const headerBtn = css({
  flexShrink: 0,
  width: '2rem',
  height: '2rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'white',
  color: 'greyscale.700',
  fontSize: '1rem',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  _hover: { backgroundColor: 'greyscale.100' },
})
