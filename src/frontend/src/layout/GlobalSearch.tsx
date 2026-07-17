import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { RiSearchLine } from '@remixicon/react'

import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { navigateTo } from '@/navigation/navigateTo'
import { useConfirm } from '@/components/ConfirmProvider'
import { useDirectoryMemberSearch } from '@/features/contacts'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import {
  searchImMessages,
  type ImSearchItem,
} from '@/features/im/api/searchImMessages'
import { resolveImUsers } from '@/features/im/api/resolveImUsers'
import {
  useRecentMeetings,
  useScheduledMeetings,
} from '@/features/meetings/api/fetchMeeting'

/**
 * Feishu-style global search (Ctrl/Cmd+K). The rail mounts the trigger; the
 * palette searches the org directory (server-side) + recent/scheduled meetings
 * (client-side filter). Picking a person opens a direct chat; picking a meeting
 * jumps to it. Mounted once in the always-present rail, so the hotkey is global.
 */

interface TriggerProps {
  collapsed?: boolean
}

export const GlobalSearch = ({ collapsed }: TriggerProps) => {
  const { t } = useTranslation('shell')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {collapsed ? (
        <button
          type="button"
          aria-label={t('search.trigger')}
          title={t('search.trigger')}
          onClick={() => setOpen(true)}
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '36px',
            height: '36px',
            border: 'none',
            borderRadius: '8px',
            backgroundColor: 'transparent',
            color: 'greyscale.700',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.100' },
          })}
        >
          <RiSearchLine size={18} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="global-search-trigger"
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            width: '100%',
            paddingX: '0.625rem',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '8px',
            backgroundColor: 'greyscale.000',
            color: 'greyscale.500',
            fontSize: '0.8125rem',
            cursor: 'pointer',
            _hover: { borderColor: 'primary.300' },
          })}
        >
          <RiSearchLine size={16} />
          <span className={css({ flex: 1, textAlign: 'left' })}>
            {t('search.trigger')}
          </span>
          <span
            className={css({
              fontSize: '0.6875rem',
              color: 'greyscale.400',
              border: '1px solid token(colors.greyscale.200)',
              borderRadius: '4px',
              paddingX: '0.25rem',
            })}
          >
            Ctrl K
          </span>
        </button>
      )}
      {open && <SearchPalette onClose={() => setOpen(false)} />}
    </>
  )
}

interface MeetingResult {
  kind: 'recent' | 'scheduled'
  key: string
  name: string
  target: string // id (recent) or slug (scheduled)
}

// 分类标签(飞书式):缩小搜索范围。联系人 + 会议 + 消息(P1-M1,jusi p15
// 服务端全文检索经 /im/search 代理)。
type SearchCategory = 'all' | 'contacts' | 'meetings' | 'messages'
const CATEGORIES: SearchCategory[] = ['all', 'contacts', 'meetings', 'messages']

const SearchPalette = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation('shell')
  const [, navigate] = useLocation()
  const { alert: showAlert } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)

  const [category, setCategory] = useState<SearchCategory>('all')
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const { data: recent = [] } = useRecentMeetings(true)
  const { data: scheduled = [] } = useScheduledMeetings(true)

  const ql = query.trim().toLowerCase()
  const showContacts = category === 'all' || category === 'contacts'
  const showMeetings = category === 'all' || category === 'meetings'
  const showMessages = category === 'all' || category === 'messages'
  const members = ql && showContacts ? selectable : []

  // 消息全文搜索(P1-M1):≥2 字才发起(与服务端校验一致);「全部」下取少量,
  // 「消息」标签下取满页。命中的发送者(jusi uid)批量解析成显示名。
  const rawQ = query.trim()
  const msgSearchEnabled = showMessages && rawQ.length >= 2
  const { data: msgData, isFetching: msgFetching } = useQuery({
    queryKey: ['im', 'msg-search', rawQ],
    queryFn: () => searchImMessages(rawQ, { limit: 20 }),
    enabled: msgSearchEnabled,
    staleTime: 15_000,
    retry: false,
  })
  const msgItems = useMemo<ImSearchItem[]>(() => {
    if (!msgSearchEnabled || !msgData) return []
    return category === 'messages' ? msgData.items : msgData.items.slice(0, 5)
  }, [msgSearchEnabled, msgData, category])
  const msgSenderUids = useMemo(
    () => [...new Set(msgItems.map((m) => m.sender_uid))],
    [msgItems]
  )
  const { data: msgSenders = {} } = useQuery({
    queryKey: ['im', 'member-names', msgSenderUids],
    queryFn: () => resolveImUsers(msgSenderUids),
    enabled: msgSenderUids.length > 0,
    staleTime: 60_000,
  })

  const meetings = useMemo<MeetingResult[]>(() => {
    if (!ql || !showMeetings) return []
    const all: MeetingResult[] = [
      ...recent.map((m) => ({
        kind: 'recent' as const,
        key: `r-${m.id}`,
        name: m.name || '',
        target: m.id,
      })),
      ...scheduled.map((m) => ({
        kind: 'scheduled' as const,
        key: `s-${m.id}`,
        name: m.name || '',
        target: m.slug || m.id,
      })),
    ]
    return all.filter((m) => m.name.toLowerCase().includes(ql)).slice(0, 8)
  }, [ql, recent, scheduled, showMeetings])

  const empty =
    !!ql &&
    !isFetching &&
    !msgFetching &&
    members.length === 0 &&
    meetings.length === 0 &&
    msgItems.length === 0

  const openMember = async (id: string) => {
    try {
      const result = await createDirectConversationByUserId(id)
      onClose()
      navigate(`/im?cid=${encodeURIComponent(result.cid)}`)
    } catch (e) {
      void showAlert({ message: e instanceof Error ? e.message : String(e) })
    }
  }
  const openMeeting = (m: MeetingResult) => {
    onClose()
    if (m.kind === 'scheduled') navigateTo('room', m.target)
    else navigateTo('meetingDetail', m.target)
  }
  // 点消息命中 → 进入该会话并按 seq 定位(P1-M2)。`t` 是 nonce:同一条命中
  // 反复点击也会重新定位。
  const openMessageHit = (m: ImSearchItem) => {
    onClose()
    navigate(
      `/im?cid=${encodeURIComponent(m.cid)}&seq=${m.seq}&t=${Date.now()}`
    )
  }
  const msgPreview = (m: ImSearchItem): string => {
    if (m.content_type === 'quote') {
      try {
        return (JSON.parse(m.body)?.text as string) || m.body
      } catch {
        return m.body
      }
    }
    if (m.content_type !== 'text') return `[${m.content_type}] ${m.body.slice(0, 40)}`
    return m.body
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('search.trigger')}
      initialFocusRef={inputRef}
      maxWidth="680px"
      maxHeight="72vh"
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.875rem 1rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <RiSearchLine size={18} className={css({ color: 'greyscale.500' })} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          data-testid="global-search-input"
          className={css({
            flex: 1,
            border: 'none',
            outline: 'none',
            fontSize: '0.9375rem',
            backgroundColor: 'transparent',
          })}
        />
      </div>

      {/* 分类标签(飞书式):点标签缩小搜索范围。 */}
      <div
        className={css({
          display: 'flex',
          gap: '0.375rem',
          padding: '0.5rem 1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
        role="tablist"
      >
        {CATEGORIES.map((cat) => {
          const active = category === cat
          return (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setCategory(cat)}
              data-testid={`global-search-tab-${cat}`}
              className={css({
                paddingX: '0.75rem',
                paddingY: '0.3125rem',
                border: 'none',
                borderRadius: '999px',
                fontSize: '0.8125rem',
                cursor: 'pointer',
                backgroundColor: active ? 'primary.100' : 'transparent',
                color: active ? 'primary.700' : 'greyscale.600',
                fontWeight: active ? '600' : undefined,
                _hover: { backgroundColor: active ? 'primary.100' : 'greyscale.100' },
              })}
            >
              {t(`search.${cat}`)}
            </button>
          )
        })}
      </div>

      <div
        className={css({
          overflowY: 'auto',
          padding: '0.5rem',
          minHeight: '380px',
        })}
      >
        {!ql && (
          <p className={hintCls}>{t('search.placeholder')}</p>
        )}
        {empty && <p className={hintCls}>{t('search.empty')}</p>}

        {members.length > 0 && (
          <Group title={t('search.contacts')}>
            {members.slice(0, 8).map((m) => {
              const label = m.full_name || m.short_name || m.email || m.id
              return (
                <ResultRow
                  key={m.id}
                  onClick={() => openMember(m.id)}
                  testId={`global-search-member-${m.id}`}
                  avatarText={label.slice(0, 1).toUpperCase()}
                  avatarSrc={m.avatar_url}
                  title={label}
                  subtitle={[m.title, m.department?.name]
                    .filter(Boolean)
                    .join(' · ')}
                />
              )
            })}
          </Group>
        )}

        {meetings.length > 0 && (
          <Group title={t('search.meetings')}>
            {meetings.map((m) => (
              <ResultRow
                key={m.key}
                onClick={() => openMeeting(m)}
                avatarText="📹"
                title={m.name || '—'}
              />
            ))}
          </Group>
        )}

        {msgItems.length > 0 && (
          <Group title={t('search.messages')}>
            {msgItems.map((m) => (
              <ResultRow
                key={`m-${m.mid}`}
                onClick={() => openMessageHit(m)}
                testId={`global-search-msg-${m.mid}`}
                avatarText="💬"
                title={msgPreview(m)}
                subtitle={[
                  msgSenders[m.sender_uid]?.full_name || m.sender_uid,
                  new Date(m.created_at).toLocaleString(),
                ].join(' · ')}
              />
            ))}
          </Group>
        )}
      </div>
    </Modal>
  )
}

const hintCls = css({
  color: 'greyscale.500',
  fontSize: '0.875rem',
  textAlign: 'center',
  padding: '1.5rem 1rem',
  margin: 0,
})

const Group = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => (
  <div className={css({ marginBottom: '0.5rem' })}>
    <div
      className={css({
        fontSize: '0.6875rem',
        fontWeight: 600,
        color: 'greyscale.500',
        textTransform: 'uppercase',
        paddingX: '0.5rem',
        paddingY: '0.375rem',
      })}
    >
      {title}
    </div>
    {children}
  </div>
)

const ResultRow = ({
  onClick,
  avatarText,
  avatarSrc,
  title,
  subtitle,
  testId,
}: {
  onClick: () => void
  avatarText: string
  /** Uploaded avatar URL (members); when present an image replaces avatarText. */
  avatarSrc?: string | null
  title: string
  subtitle?: string
  testId?: string
}) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    className={css({
      display: 'flex',
      alignItems: 'center',
      gap: '0.625rem',
      width: '100%',
      paddingX: '0.5rem',
      paddingY: '0.5rem',
      border: 'none',
      borderRadius: '8px',
      backgroundColor: 'transparent',
      cursor: 'pointer',
      textAlign: 'left',
      _hover: { backgroundColor: 'primary.50' },
    })}
  >
    {avatarSrc ? (
      <img
        src={avatarSrc}
        alt=""
        aria-hidden="true"
        className={css({
          flexShrink: 0,
          width: '32px',
          height: '32px',
          borderRadius: '7px',
          objectFit: 'cover',
        })}
      />
    ) : (
      <span
        className={css({
          flexShrink: 0,
          width: '32px',
          height: '32px',
          borderRadius: '7px',
          backgroundColor: 'primary.100',
          color: 'primary.700',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.8125rem',
        })}
      >
        {avatarText}
      </span>
    )}
    <span className={css({ minWidth: 0, flex: 1 })}>
      <span
        className={css({
          display: 'block',
          fontSize: '0.875rem',
          color: 'greyscale.900',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        {title}
      </span>
      {subtitle && (
        <span
          className={css({
            display: 'block',
            fontSize: '0.75rem',
            color: 'greyscale.500',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {subtitle}
        </span>
      )}
    </span>
  </button>
)
