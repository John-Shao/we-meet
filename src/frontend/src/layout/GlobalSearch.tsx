import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { RiSearchLine, RiSparklingLine } from '@remixicon/react'
import ReactMarkdown from 'react-markdown'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { css, cx } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { fetchApi } from '@/api/fetchApi'
import { navigateTo } from '@/navigation/navigateTo'
import { useConfig } from '@/api/useConfig'
import { useConfirm } from '@/components/ConfirmProvider'
import { useDirectoryMemberSearch } from '@/features/contacts'
import { createDirectConversationByUserId } from '@/features/im/api/createDirectConversation'
import {
  searchImMessages,
  type ImSearchItem,
} from '@/features/im/api/searchImMessages'
import { resolveImUsers } from '@/features/im/api/resolveImUsers'
import { fetchImToken } from '@/features/im/api/fetchImToken'
import {
  useRecentMeetings,
  useScheduledMeetings,
} from '@/features/meetings/api/fetchMeeting'
import {
  useGlobalAsk,
  type GlobalAskCitation,
} from '@/features/global-ask/useGlobalAsk'

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
// 服务端全文检索经 /im/search 代理)+ 文档(P1-4 搜索入口统一 M1,Docs s2s
// 代理)+ AI 问答(P1-4,config flag 控显隐)。
type SearchCategory =
  | 'all'
  | 'contacts'
  | 'meetings'
  | 'messages'
  | 'docs'
  | 'ai'
const BASE_CATEGORIES: SearchCategory[] = [
  'all',
  'contacts',
  'meetings',
  'messages',
  'docs',
]

/** 文档命中(后端 /docs/search/ 代理,可见性在 Docs 侧过滤)。 */
interface DocsSearchHit {
  id: string
  title: string
  updated_at: string
  url: string
}
const searchDocs = (q: string): Promise<DocsSearchHit[]> =>
  fetchApi<{ results: DocsSearchHit[] }>(
    `/docs/search/?q=${encodeURIComponent(q)}`
  ).then((r) => r.results)

const SearchPalette = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation('shell')
  const [, navigate] = useLocation()
  const { alert: showAlert } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)

  const [category, setCategory] = useState<SearchCategory>('all')
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const { data: recent = [] } = useRecentMeetings(true)
  const { data: scheduled = [] } = useScheduledMeetings(true)
  // P1-4 AI 问答:flag 缺省视为开(旧后端无该字段时也亮,端点侧另有 404 gate)。
  const { data: apiConfig } = useConfig()
  const aiEnabled = apiConfig?.search_ai?.enabled !== false
  const categories: SearchCategory[] = aiEnabled
    ? [...BASE_CATEGORIES, 'ai']
    : BASE_CATEGORIES
  const { state: askState, ask, abort: abortAsk } = useGlobalAsk()
  // 关面板必须断流:SSE 占用 gunicorn sync worker(设计 §D4 红线)。
  const close = () => {
    abortAsk()
    onClose()
  }
  useEffect(() => () => abortAsk(), [abortAsk])
  const submitAsk = () => {
    const q = query.trim()
    if (q.length < 2) return
    setCategory('ai')
    void ask(q)
  }

  const ql = query.trim().toLowerCase()
  const showContacts = category === 'all' || category === 'contacts'
  const showMeetings = category === 'all' || category === 'meetings'
  const showMessages = category === 'all' || category === 'messages'
  const showDocs = category === 'all' || category === 'docs'
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

  // 会话组(对齐 App「会话」快捷径):群名/直聊对端名 本地过滤,点击直达
  // 聊天。列表=打开面板时对全局 ImUnreadProvider 维护的 ['im','conversations']
  // 缓存取快照(面板条件挂载,每次打开都是新鲜快照;IM 未配置时缓存不存在
  // →恒空,天然降级,不触碰 SDK)。直聊对端名批量解析,解析不出的不参与
  // 匹配(避免「私聊」兜底文案造成噪音命中)。
  const queryClient = useQueryClient()
  const [convList] = useState<ConversationSummary[]>(
    () =>
      queryClient.getQueryData<ConversationSummary[]>([
        'im',
        'conversations',
      ]) ?? []
  )
  const showConvs = category === 'all' || category === 'messages'
  const { data: imSelf } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    enabled: convList.length > 0,
    staleTime: 600_000,
  })
  const selfUid = imSelf?.uid ?? ''
  const convPeerUids = useMemo(
    () =>
      [
        ...new Set(
          convList
            .filter((c) => c.type === 'direct')
            .map((c) => c.members.find((u) => u !== selfUid))
            .filter((u): u is string => !!u)
        ),
      ].sort(),
    [convList, selfUid]
  )
  const { data: convPeerNames = {} } = useQuery({
    queryKey: ['im', 'peer-names', convPeerUids],
    queryFn: () => resolveImUsers(convPeerUids),
    enabled: convPeerUids.length > 0 && !!selfUid,
    staleTime: 60_000,
  })
  const convHits = useMemo(() => {
    if (!ql || !showConvs) return []
    return convList
      .map((c) => {
        const name =
          c.type === 'group'
            ? c.name.trim()
            : (() => {
                const peer = c.members.find((u) => u !== selfUid)
                return (peer && convPeerNames[peer]?.full_name) || ''
              })()
        return { cid: c.cid, name }
      })
      .filter((c) => !!c.name && c.name.toLowerCase().includes(ql))
      .slice(0, 8)
  }, [ql, showConvs, convList, convPeerNames, selfUid])

  // 文档搜索(P1-4 M1):≥2 字触发;「全部」下取 4 条,「文档」标签取满 8。
  const docsSearchEnabled = showDocs && rawQ.length >= 2
  const { data: docsData = [], isFetching: docsFetching } = useQuery({
    queryKey: ['docs', 'search', rawQ],
    queryFn: () => searchDocs(rawQ),
    enabled: docsSearchEnabled,
    staleTime: 15_000,
    retry: false,
  })
  const docsHits = useMemo<DocsSearchHit[]>(() => {
    if (!docsSearchEnabled) return []
    return category === 'docs' ? docsData : docsData.slice(0, 4)
  }, [docsSearchEnabled, docsData, category])

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
    !docsFetching &&
    convHits.length === 0 &&
    members.length === 0 &&
    meetings.length === 0 &&
    msgItems.length === 0 &&
    docsHits.length === 0

  const openMember = async (id: string) => {
    try {
      const result = await createDirectConversationByUserId(id)
      close()
      navigate(`/im?cid=${encodeURIComponent(result.cid)}`)
    } catch (e) {
      void showAlert({ message: e instanceof Error ? e.message : String(e) })
    }
  }
  const openMeeting = (m: MeetingResult) => {
    close()
    if (m.kind === 'scheduled') navigateTo('room', m.target)
    else navigateTo('meetingDetail', m.target)
  }
  // 点消息命中 → 进入该会话并按 seq 定位(P1-M2)。`t` 是 nonce:同一条命中
  // 反复点击也会重新定位。
  const openMessageHit = (m: ImSearchItem) => {
    close()
    navigate(
      `/im?cid=${encodeURIComponent(m.cid)}&seq=${m.seq}&t=${Date.now()}`
    )
  }
  // 会话命中 → 直达聊天(不带 seq,落在最新位置)。
  const openConvHit = (cid: string) => {
    close()
    navigate(`/im?cid=${encodeURIComponent(cid)}`)
  }
  // 文档命中 → 新标签打开 Docs 深链(与 MeetingDoc 链接既有口径一致;
  // /docs iframe 内深链留待后续)。
  const openDocHit = (hit: DocsSearchHit) => {
    close()
    window.open(hit.url, '_blank', 'noopener')
  }
  // P1-4 引用 chip 三类跳转(§D4):会议/纪要 → 详情;消息 → IM 定位;
  // 日程 → 日历按日定位(?d,CalendarRoute 新参数)。
  const openCitation = (c: GlobalAskCitation) => {
    close()
    if (c.kind === 'meeting' && c.room_id) {
      navigateTo('meetingDetail', c.room_id)
    } else if (c.kind === 'im' && c.cid) {
      navigate(
        `/im?cid=${encodeURIComponent(c.cid)}&seq=${c.seq ?? ''}&t=${Date.now()}`
      )
    } else if (c.kind === 'calendar' && c.date) {
      // M3:带 event_id 时事件级定位(自动开详情);缺省退回按日定位。
      navigate(
        c.event_id
          ? `/calendar?d=${c.date}&event=${c.event_id}`
          : `/calendar?d=${c.date}`
      )
    }
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
      onClose={close}
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
          onKeyDown={(e) => {
            // AI 标签内 Enter = 显式触发(绝不随输入自动发起,成本闸门 §D4)。
            if (e.key === 'Enter' && category === 'ai' && aiEnabled) {
              e.preventDefault()
              submitAsk()
            }
          }}
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
        {categories.map((cat) => {
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
        {category === 'ai' ? (
          <AiPanel
            t={t}
            state={askState}
            question={rawQ}
            onAsk={submitAsk}
            onOpenCitation={openCitation}
          />
        ) : (
          <>
        {!ql && (
          <p className={hintCls}>{t('search.placeholder')}</p>
        )}
        {empty && <p className={hintCls}>{t('search.empty')}</p>}

        {/* P1-4 快捷行:「全部」下 q≥2 时置顶,点击切 AI 标签并提交。 */}
        {aiEnabled && category === 'all' && rawQ.length >= 2 && (
          <button
            type="button"
            onClick={submitAsk}
            data-testid="global-search-ask-ai"
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
              width: '100%',
              paddingX: '0.5rem',
              paddingY: '0.625rem',
              border: 'none',
              borderRadius: '8px',
              backgroundColor: 'primary.50',
              color: 'primary.700',
              fontSize: '0.875rem',
              cursor: 'pointer',
              textAlign: 'left',
              marginBottom: '0.375rem',
              _hover: { backgroundColor: 'primary.100' },
            })}
          >
            <RiSparklingLine size={18} />
            <span
              className={css({
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              })}
            >
              {t('search.askAi', { q: rawQ })}
            </span>
          </button>
        )}

        {convHits.length > 0 && (
          <Group title={t('search.conversations')}>
            {convHits.map((c) => (
              <ResultRow
                key={`c-${c.cid}`}
                onClick={() => openConvHit(c.cid)}
                testId={`global-search-conv-${c.cid}`}
                avatarText={c.name.slice(0, 1).toUpperCase()}
                title={c.name}
              />
            ))}
          </Group>
        )}

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

        {docsHits.length > 0 && (
          <Group title={t('search.docs')}>
            {docsHits.map((d) => (
              <ResultRow
                key={`d-${d.id}`}
                onClick={() => openDocHit(d)}
                testId={`global-search-doc-${d.id}`}
                avatarText="📄"
                title={d.title || '—'}
                subtitle={
                  d.updated_at
                    ? new Date(d.updated_at).toLocaleString()
                    : undefined
                }
              />
            ))}
          </Group>
        )}
          </>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// P1-4 AI 问答面板(§D2/§D4/§D7)
// ---------------------------------------------------------------------------

const AiPanel = ({
  t,
  state,
  question,
  onAsk,
  onOpenCitation,
}: {
  t: (k: string, opts?: Record<string, unknown>) => string
  state: ReturnType<typeof useGlobalAsk>['state']
  question: string
  onAsk: () => void
  onOpenCitation: (c: GlobalAskCitation) => void
}) => {
  if (state.status === 'idle') {
    return (
      <div className={css({ padding: '0.5rem' })}>
        <p className={hintCls}>{t('search.aiHint')}</p>
        {question.trim().length >= 2 && (
          <button
            type="button"
            onClick={onAsk}
            data-testid="global-search-ai-submit"
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              margin: '0 auto',
              paddingX: '1rem',
              paddingY: '0.5rem',
              border: 'none',
              borderRadius: '999px',
              backgroundColor: 'primary.500',
              color: 'white',
              fontSize: '0.875rem',
              cursor: 'pointer',
            })}
          >
            <RiSparklingLine size={16} />
            {t('search.askAi', { q: question.trim() })}
          </button>
        )}
      </div>
    )
  }

  const used = new Set(state.citationsUsed)
  const settled = state.status === 'done'
  // done 且模型守规:已用引用高亮、未用折叠;漏标/降级 → 全部平铺可点(§D2)。
  const splitMode = settled && !state.degraded && used.size > 0
  const primary = splitMode
    ? state.citations.filter((c) => used.has(c.n))
    : state.citations
  const secondary = splitMode
    ? state.citations.filter((c) => !used.has(c.n))
    : []

  return (
    <div className={css({ padding: '0.5rem' })} data-testid="global-search-ai-panel">
      <div
        className={css({
          fontSize: '0.8125rem',
          color: 'greyscale.500',
          marginBottom: '0.375rem',
        })}
      >
        ✨ {state.question}
      </div>

      {state.degraded && (
        <div
          className={css({
            fontSize: '0.8125rem',
            color: 'greyscale.700',
            backgroundColor: 'greyscale.100',
            borderRadius: '8px',
            padding: '0.5rem 0.75rem',
            marginBottom: '0.5rem',
          })}
          data-testid="global-search-ai-degraded"
        >
          {t('search.aiDegraded')}
        </div>
      )}
      {state.error && (
        <div
          className={css({
            fontSize: '0.8125rem',
            color: 'danger.600',
            marginBottom: '0.5rem',
          })}
        >
          {/* 429 = 限流(10/min 突发或日 quota),给专属文案而非笼统失败。 */}
          {state.error === '429' ? t('search.aiQuota') : t('search.aiError')}
        </div>
      )}
      {/* M2 拍板③:IM 源缺席弱提示(jusi 不可达/无 IM 身份),不弹窗不报错。 */}
      {settled && state.sources.im === 'skipped' && !state.degraded && (
        <div
          className={css({
            fontSize: '0.75rem',
            color: 'greyscale.500',
            marginBottom: '0.375rem',
          })}
          data-testid="global-search-ai-im-skipped"
        >
          {t('search.aiImUnavailable')}
        </div>
      )}

      {state.answer && (
        <div className={aiAnswerCls}>
          <ReactMarkdown>{state.answer}</ReactMarkdown>
        </div>
      )}
      {state.status === 'asking' && !state.answer && (
        <p className={hintCls}>{t('search.aiAsking')}</p>
      )}

      {state.citations.length > 0 && (
        <div className={css({ marginTop: '0.75rem' })}>
          <div
            className={css({
              fontSize: '0.6875rem',
              fontWeight: 600,
              color: 'greyscale.500',
              textTransform: 'uppercase',
              marginBottom: '0.375rem',
            })}
          >
            {t('search.aiSources')}
          </div>
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.375rem',
            })}
          >
            {primary.map((c) => (
              <CitationChip
                key={c.n}
                citation={c}
                highlighted={splitMode}
                onClick={() => onOpenCitation(c)}
              />
            ))}
          </div>
          {secondary.length > 0 && (
            <details className={css({ marginTop: '0.375rem' })}>
              <summary
                className={css({
                  fontSize: '0.75rem',
                  color: 'greyscale.500',
                  cursor: 'pointer',
                })}
              >
                {t('search.aiMoreSources', { count: secondary.length })}
              </summary>
              <div
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.375rem',
                  marginTop: '0.375rem',
                })}
              >
                {secondary.map((c) => (
                  <CitationChip
                    key={c.n}
                    citation={c}
                    onClick={() => onOpenCitation(c)}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

const CitationChip = ({
  citation,
  highlighted,
  onClick,
}: {
  citation: GlobalAskCitation
  highlighted?: boolean
  onClick: () => void
}) => {
  const icon =
    citation.kind === 'calendar' ? '📅' : citation.kind === 'im' ? '💬' : '📹'
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`ai-citation-${citation.n}`}
      className={cx(
        css({
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.375rem',
          maxWidth: '100%',
          paddingX: '0.625rem',
          paddingY: '0.3125rem',
          borderRadius: '999px',
          border: '1px solid token(colors.greyscale.200)',
          backgroundColor: 'greyscale.000',
          fontSize: '0.75rem',
          color: 'greyscale.700',
          cursor: 'pointer',
          _hover: { borderColor: 'primary.300' },
        }),
        highlighted
          ? css({
              borderColor: 'primary.400',
              backgroundColor: 'primary.50',
              color: 'primary.700',
            })
          : undefined
      )}
    >
      <span>{icon}</span>
      <span
        className={css({
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        [{citation.n}] {citation.title}
      </span>
    </button>
  )
}

const aiAnswerCls = css({
  fontSize: '0.875rem',
  lineHeight: 1.7,
  color: 'greyscale.900',
  '& > :first-child': { marginTop: 0 },
  '& p': { margin: '0.375rem 0' },
  '& ul, & ol': { margin: '0.25rem 0 0.375rem 1.25rem' },
  '& ul': { listStyleType: 'disc' },
  '& code': {
    backgroundColor: 'greyscale.100',
    padding: '0.05rem 0.25rem',
    borderRadius: '3px',
    fontFamily: 'monospace',
  },
})

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
