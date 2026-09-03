import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'

import { Avatar } from './Avatar'
import { GroupAvatar, type GroupAvatarMember } from './GroupAvatar'
import { MessageContextMenu, type ContextMenuItem } from './MessageContextMenu'

interface Props {
  conversations: ConversationSummary[]
  selectedCID: string | null
  onSelect: (cid: string) => void
  loading?: boolean
  /** Resolve a conversation's display label (group name / direct peer name). */
  nameOf: (c: ConversationSummary) => string
  /** Resolve a conversation's avatar URL (direct peer); undefined → tinted initial. */
  avatarOf?: (c: ConversationSummary) => string | undefined
  /** Resolve a group's member tiles for the mosaic avatar; undefined → fall back. */
  membersOf?: (c: ConversationSummary) => GroupAvatarMember[] | undefined
  /** Soft-hide the conversation from the caller's list. */
  onDelete: (c: ConversationSummary) => void
  /** Leave a group conversation. */
  onLeave: (c: ConversationSummary) => void
  /** Toggle the caller's private pinned state for the conversation. */
  onTogglePinned: (c: ConversationSummary) => void
  /** Toggle the caller's private notification mute state. */
  onToggleMuted: (c: ConversationSummary) => void
  /** cids with an unread @-mention of the current user → show a red "@" marker. */
  mentionedCids?: Set<string>
  /** cids whose direct peer is a 星标联系人 → show a ⭐ after the name. */
  starredCids?: Set<string>
  /**
   * cids whose direct peer has 他的消息特别提醒 on → 🔔 marker.
   *
   * ⚠️ Callers must exclude muted conversations: there the bypass cannot happen
   * (jusi drops muted members before the push webhook), so a "will notify you"
   * icon next to the 免打扰 dot would be a promise we do not keep.
   */
  specialAlertCids?: Set<string>
  /**
   * Last-message preview line (P11): formatted text (group: "sender: body";
   * direct: body) + the message unix-ms timestamp. Null when there's nothing
   * to preview (empty / fully-cleared conversation).
   */
  previewOf?: (c: ConversationSummary) => { text: string; ts: number } | null
}

// Short, list-style timestamp: today → HH:MM, yesterday → 昨天, this week →
// localized weekday, older → M/D. `now`-relative; day boundaries by calendar day.
const fmtTime = (ts: number, locale: string, yesterday: string): string => {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  if (dayDiff === 1) return yesterday
  if (dayDiff < 7) return d.toLocaleDateString(locale, { weekday: 'short' })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export const ConversationList = ({
  conversations,
  selectedCID,
  onSelect,
  loading,
  nameOf,
  avatarOf,
  membersOf,
  onDelete,
  onLeave,
  onTogglePinned,
  onToggleMuted,
  mentionedCids,
  starredCids,
  specialAlertCids,
  previewOf,
}: Props) => {
  const { t, i18n } = useTranslation('im')
  const [menu, setMenu] = useState<{
    x: number
    y: number
    conversation: ConversationSummary
  } | null>(null)

  const openMenu = (
    event: React.MouseEvent,
    conversation: ConversationSummary
  ) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, conversation })
  }

  const openKeyboardMenu = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    conversation: ConversationSummary
  ) => {
    if (
      event.key !== 'ContextMenu' &&
      !(event.shiftKey && event.key === 'F10')
    ) {
      return
    }
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      x: rect.left + Math.min(32, rect.width / 2),
      y: rect.top + Math.min(32, rect.height / 2),
      conversation,
    })
  }

  const menuItems = (conversation: ConversationSummary): ContextMenuItem[] => [
    {
      key: 'pin',
      label: conversation.pinned
        ? t('list.contextMenu.unpin')
        : t('list.contextMenu.pin'),
      onSelect: () => onTogglePinned(conversation),
    },
    {
      key: 'mute',
      label: conversation.muted
        ? t('list.contextMenu.unmute')
        : t('list.contextMenu.mute'),
      onSelect: () => onToggleMuted(conversation),
    },
    {
      key: 'delete',
      label: t('list.contextMenu.delete'),
      danger: true,
      onSelect: () => onDelete(conversation),
    },
    ...(conversation.type === 'group'
      ? [
          {
            key: 'leave',
            label: t('list.contextMenu.leave'),
            danger: true,
            onSelect: () => onLeave(conversation),
          },
        ]
      : []),
  ]

  if (loading) {
    return <StateHint loading>{t('list.loading')}</StateHint>
  }
  if (conversations.length === 0) {
    return (
      <div className={css({ padding: '1rem', color: 'greyscale.500' })}>
        {t('list.empty')}
      </div>
    )
  }

  return (
    <>
      <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
        {conversations.map((c) => {
          const preview = previewOf?.(c) ?? null
          const hasSecondLine = !!preview?.text || c.unread_count > 0
          const groupTiles = c.type === 'group' ? membersOf?.(c) : undefined
          return (
            <li
              key={c.cid}
              onContextMenu={(event) => openMenu(event, c)}
              className={css({
                display: 'flex',
                alignItems: 'stretch',
                borderBottom: '1px solid token(colors.greyscale.100)',
                // 选中用会翻转的 greyscale.200(比 hover 的 .100 深一档、可区分),
                // 避免原 primary.100 浅蓝底在深色下与翻转后的浅色名字撞色看不清。
                backgroundColor:
                  selectedCID === c.cid ? 'greyscale.200' : 'transparent',
                _hover: {
                  backgroundColor: 'greyscale.100',
                },
              })}
            >
              <button
                type="button"
                onClick={() => onSelect(c.cid)}
                onKeyDown={(event) => openKeyboardMenu(event, c)}
                aria-haspopup="menu"
                aria-expanded={menu?.conversation.cid === c.cid}
                className={css({
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.625rem',
                  paddingX: '0.875rem',
                  paddingY: '0.625rem',
                  border: 'none',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                })}
                data-testid={`conv-item-${c.cid}`}
              >
                {groupTiles && groupTiles.length > 0 ? (
                  <GroupAvatar members={groupTiles} size="2.5rem" />
                ) : (
                  <Avatar name={nameOf(c)} src={avatarOf?.(c)} size="2.5rem" />
                )}
                <span
                  className={css({
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.125rem',
                  })}
                >
                  {/* Line 1: pin / @ / name … time */}
                  <span
                    className={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    })}
                  >
                    <span
                      className={css({
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        fontWeight: c.unread_count > 0 ? 'bold' : 'normal',
                        color: 'greyscale.900',
                      })}
                    >
                      {c.pinned && (
                        <span
                          aria-label={t('manage.pin')}
                          title={t('manage.pin')}
                          className={css({
                            flexShrink: 0,
                            fontSize: '0.6875rem',
                            opacity: 0.6,
                          })}
                        >
                          📌
                        </span>
                      )}
                      {mentionedCids?.has(c.cid) && (
                        <span
                          aria-label={t('mention.notice')}
                          title={t('mention.notice')}
                          className={css({
                            flexShrink: 0,
                            fontWeight: 'bold',
                            fontSize: '0.8125rem',
                            color: 'danger.600',
                          })}
                        >
                          @
                        </span>
                      )}
                      <span
                        className={css({
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        })}
                      >
                        {nameOf(c)}
                      </span>
                      {/* 星标联系人:名字后跟一颗 ⭐。 */}
                      {starredCids?.has(c.cid) && (
                        <span
                          aria-label={t('starred.marker')}
                          title={t('starred.marker')}
                          className={css({
                            flexShrink: 0,
                            fontSize: '0.6875rem',
                          })}
                        >
                          ⭐
                        </span>
                      )}
                      {/* 「他的消息特别提醒」:一个铃铛。muted 的会话已在上游排除,
                        所以它绝不会和免打扰的灰点并排自相矛盾。 */}
                      {specialAlertCids?.has(c.cid) && (
                        <span
                          aria-label={t('specialAlert.marker')}
                          title={t('specialAlert.marker')}
                          className={css({
                            flexShrink: 0,
                            fontSize: '0.6875rem',
                          })}
                        >
                          🔔
                        </span>
                      )}
                    </span>
                    {preview && (
                      <span
                        className={css({
                          flexShrink: 0,
                          fontSize: '0.6875rem',
                          color: 'greyscale.500',
                        })}
                      >
                        {fmtTime(
                          preview.ts,
                          i18n.language,
                          t('time.yesterday')
                        )}
                      </span>
                    )}
                  </span>

                  {/* Line 2: preview … unread */}
                  {hasSecondLine && (
                    <span
                      className={css({
                        display: 'flex',
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
                          fontSize: '0.8125rem',
                          color: 'greyscale.500',
                        })}
                      >
                        {preview?.text ?? ''}
                      </span>
                      {c.unread_count > 0 &&
                        (c.muted ? (
                          // 免打扰:只显小灰点,不显数字(对齐飞书)。
                          <span
                            aria-label={String(c.unread_count)}
                            className={css({
                              flexShrink: 0,
                              width: '0.5rem',
                              height: '0.5rem',
                              borderRadius: '999px',
                              backgroundColor: 'greyscale.400',
                            })}
                          />
                        ) : (
                          <span
                            className={css({
                              flexShrink: 0,
                              paddingX: '0.5rem',
                              paddingY: '0.125rem',
                              borderRadius: '999px',
                              fontSize: '0.75rem',
                              backgroundColor: 'primary.500',
                              color: 'white',
                            })}
                          >
                            {c.unread_count}
                          </span>
                        ))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {menu && (
        <MessageContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.conversation)}
          onClose={() => setMenu(null)}
          testIdPrefix="conv-ctx"
        />
      )}
    </>
  )
}
