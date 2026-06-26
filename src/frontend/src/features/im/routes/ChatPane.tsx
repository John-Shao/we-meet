import { useEffect, useMemo, useRef } from 'react'
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
  /** Open the group info / member panel (group only). */
  onOpenInfo?: () => void
  /** Open the add-members picker (group only). */
  onAddMembers?: () => void
}

export const ChatPane = ({
  client,
  conversation,
  title,
  currentUserUID,
  sendDisabled,
  onOpenInfo,
  onAddMembers,
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
  const nameOf = useMemo(
    () => (uid: string) => names[uid]?.full_name || uid,
    [names],
  )
  const everyone = t('mention.everyone')
  const selfName = names[currentUserUID]?.full_name || ''
  // Names highlightable in message bodies: 所有人 + every member (incl. self).
  const highlightNames = useMemo(
    () =>
      isGroup
        ? [everyone, ...memberUids.map((u) => names[u]?.full_name).filter((n): n is string => !!n)]
        : [],
    [isGroup, everyone, memberUids, names],
  )
  // @-mention dropdown suggestions: 所有人 + other members (not yourself).
  const mentionables = useMemo(
    () =>
      isGroup
        ? [
            everyone,
            ...memberUids
              .filter((u) => u !== currentUserUID)
              .map((u) => names[u]?.full_name)
              .filter((n): n is string => !!n),
          ]
        : [],
    [isGroup, everyone, memberUids, names, currentUserUID],
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
          {isGroup && (
            <div className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>
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
            title={t('manage.info')}
            aria-label={t('manage.info')}
            data-testid="chat-group-info"
            className={headerBtn}
          >
            ⋯
          </button>
        )}
      </div>

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
              showSender={isGroup}
              mentionNames={highlightNames}
              selfMentionNames={[selfName, everyone].filter(Boolean)}
            />
          ))
        )}
      </div>
      <MessageInput onSend={onSend} disabled={sendDisabled} mentionables={mentionables} />
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
