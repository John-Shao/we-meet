import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSnapshot } from 'valtio'
import { RiPhoneLine, RiVidiconLine } from '@remixicon/react'
import type { Client, ConversationSummary, Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { fetchApi } from '@/api/fetchApi'
import { useUser } from '@/features/auth'
import { useConfirm } from '@/components/ConfirmProvider'
import { EventDetailHost } from '@/features/calendar'

import { resolveImUsers } from '../api/resolveImUsers'
import { richTextPreview } from '../components/richText'
import { richCardPreview } from '../components/richCard'
import { useCardStates } from '../hooks/useCardStates'
import { clickCardButton } from '../api/cardStates'
import { IM_SYSTEM_UID } from '../components/eventCard'
import { buildDocCardBody } from '../components/docCard'
import { DocPickerDialog } from '../components/DocPickerDialog'
import { grantDocAccess } from '../api/grantDocAccess'
import type { MyDocumentHit } from '../api/fetchMyDocuments'
import { resolveChatImages } from '../api/resolveChatImages'
import { uploadChatImage, ChatImageError } from '../api/uploadChatImage'
import { uploadChatFile, ChatFileError } from '../api/uploadChatFile'
import {
  fetchCustomEmojis,
  fetchInputPreferences,
  readLocalDrafts,
  saveRecentEmojis,
  writeLocalDraft,
  type RecentEmoji,
} from '../api/inputSync'
import { markLater } from '../api/markLater'
import { MessageInput, type ReplyPreview } from '../components/MessageInput'
import { PinnedBar } from '../components/PinnedBar'
import { MessageItem, type ReactionChip } from '../components/MessageItem'
import { ImageLightbox } from '../components/ImageLightbox'
import {
  MergedRecordDialog,
  type MergedBody,
} from '../components/MergedRecordDialog'
import {
  ReadReceiptList,
  type ReadReceiptMember,
} from '../components/ReadReceiptList'
import {
  MessageContextMenu,
  type ContextMenuItem,
} from '../components/MessageContextMenu'
import { useMessages } from '../hooks/useMessages'
import { useReadMarkers } from '../hooks/useReadMarkers'
import {
  callStore,
  startCall,
  startGroupVoiceCall,
} from '../call/callController'
import { GroupVoiceCallPicker } from '../call/GroupVoiceCallPicker'
import { navigateTo } from '@/navigation/navigateTo'

// Recall is allowed only on your own messages within this window (WeChat: 2 min).
const RECALL_WINDOW_MS = 2 * 60 * 1000

// Quick-reaction emojis offered in the message context menu.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// Control message types that never render as a chat bubble (filtered from the
// stream; they drive recall / reaction aggregation instead).
// 控制消息:不进消息流、不出右键菜单、不计入转发选择。card-state 是卡片
// 按钮的点击结果(叠加层),同样只该改渲染不该自成一行。
const CONTROL_TYPES = new Set(['recall', 'reaction', 'card-state'])

// 时间分隔条(飞书/微信式):相邻消息间隔超过该阈值时,在消息流中插一条居中时间。
const TIME_DIVIDER_GAP_MS = 5 * 60 * 1000

// 分隔条文案:今天→HH:MM、昨天→「昨天 HH:MM」、跨天→「M月D日 HH:MM」(本地化),
// 跨年再带年份。镜像 ConversationList 的 fmtTime 思路,但始终带具体时分。
const fmtDivider = (ts: number, locale: string, yesterday: string): string => {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
  if (dayDiff <= 0) return time
  if (dayDiff === 1) return `${yesterday} ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  const datePart = d.toLocaleDateString(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
  )
  return `${datePart} ${time}`
}

const TimeDivider = ({ label }: { label: string }) => (
  <div
    className={css({
      display: 'flex',
      justifyContent: 'center',
      paddingY: '0.5rem',
    })}
    data-testid="im-time-divider"
  >
    <span
      className={css({
        fontSize: '0.6875rem',
        color: 'greyscale.500',
        paddingX: '0.5rem',
      })}
    >
      {label}
    </span>
  </div>
)

interface ReactionState {
  // emoji → set of reactor uids (after replaying add/remove in seq order).
  [emoji: string]: Set<string>
}

/** A short, single-line preview of a message for quoting / list preview. */
const snippetOf = (m: Message, t: (k: string) => string): string => {
  if (m.content_type === 'image')
    return m.body.startsWith('emoji/') ? t('preview.emoji') : t('preview.image')
  if (m.content_type === 'file') return t('preview.file')
  if (m.content_type === 'voice') return t('preview.voice')
  if (m.content_type === 'merged') return t('preview.merged')
  if (m.content_type === 'call-log') return t('preview.call')
  if (m.content_type === 'group-call') return t('preview.call')
  if (m.content_type === 'phone-viewed') return t('preview.phoneViewed')
  if (m.content_type === 'event-card') return t('preview.event')
  if (m.content_type === 'meeting-card') return t('preview.meeting')
  if (m.content_type === 'calendar-card') return '日历分享'
  // One branch here fixes three downstream users at once: the quote bar,
  // the 稍后处理 snippet and the merged-forward snapshot.
  if (m.content_type === 'rich-text')
    return richTextPreview(m.body) || t('preview.richText')
  if (m.content_type === 'rich-card')
    return richCardPreview(m.body) || t('preview.richCard')
  if (m.content_type === 'quote') {
    try {
      return (JSON.parse(m.body)?.text as string) || ''
    } catch {
      return ''
    }
  }
  return m.body.slice(0, 60)
}

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
  /** P8：开合会话日程抽屉（ImRoute 持有面板）。 */
  onOpenCalendar?: () => void
  /** Forward a message to another conversation (picker lives in ImRoute). */
  onForward?: (m: Message) => void
  /** 多选转发(合并/逐条):选好后派发给 ImRoute 走目标选择器。 */
  onForwardMany?: (
    payload:
      | { mode: 'each'; messages: Message[] }
      | { mode: 'merged'; merged: MergedBody }
  ) => void
  /** Group info / member side panel; rendered to the right of the message
   * stream, below the header (Feishu-style). Null when collapsed. */
  infoPanel?: ReactNode
  /** Navigate to a member's personal info page (userId → contacts detail). */
  onMemberClick?: (userId: string) => void
  /** P1-M2 消息定位: open the history anchored at this seq (search hit /
   * 稍后处理跳转), scroll it into view and flash it. `key` is a nonce so
   * clicking the same hit twice re-locates. */
  locate?: { seq: number; key: string } | null
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
  onOpenCalendar,
  onForward,
  onForwardMany,
  infoPanel,
  onMemberClick,
  locate,
}: Props) => {
  const { t, i18n } = useTranslation('im')
  const { user } = useUser()
  // P1 通话: re-render the header buttons' disabled state on call transitions.
  const callSnap = useSnapshot(callStore)
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const queryClient = useQueryClient()
  const cid = conversation.cid
  const isGroup = conversation.type === 'group'
  // P1-M2 定位: the anchor is owned locally so「跳至最新」can clear it; a new
  // locate.key (nonce) re-anchors even for the same seq. The cid is captured
  // at set-time so a stale anchor never bleeds into another conversation the
  // user switches to manually.
  const [anchor, setAnchor] = useState<{
    seq: number
    key: string
    cid: string
  } | null>(locate ? { ...locate, cid } : null)
  useEffect(() => {
    setAnchor(locate ? { ...locate, cid } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.key])
  const activeAnchor = anchor && anchor.cid === cid ? anchor : null
  // P8 日程卡片点「查看」→ 本地宿主打开日程详情(EventDetailHost 按 id 拉取)。
  const [viewEventId, setViewEventId] = useState<string | null>(null)
  // 分享云文档到聊天(入口 A):输入框「文档」按钮 → 选择器。
  const [showDocPicker, setShowDocPicker] = useState(false)
  const { data: inputPreferences } = useQuery({
    queryKey: ['im', 'input-preferences'],
    queryFn: fetchInputPreferences,
    staleTime: 30_000,
  })
  const { data: customEmojis = [] } = useQuery({
    queryKey: ['im', 'custom-emojis'],
    queryFn: fetchCustomEmojis,
    staleTime: 60_000,
  })
  const [recentEmojis, setRecentEmojis] = useState<RecentEmoji[]>([])
  useEffect(() => {
    if (inputPreferences) setRecentEmojis(inputPreferences.recent_emojis)
  }, [inputPreferences])
  const rememberEmoji = (emoji: RecentEmoji) => {
    const identity =
      emoji.kind === 'unicode' ? `u:${emoji.value}` : `c:${emoji.id}`
    setRecentEmojis((previous) => {
      const next = [
        emoji,
        ...previous.filter((item) =>
          item.kind === 'unicode'
            ? `u:${item.value}` !== identity
            : `c:${item.id}` !== identity
        ),
      ].slice(0, 24)
      void saveRecentEmojis(next).catch(() => undefined)
      return next
    })
  }
  const {
    data: messages = [],
    isLoading,
    caughtUp,
    hasMoreOlder,
    loadOlder,
    loadNewer,
  } = useMessages(client, cid, activeAnchor)
  // 定位闪烁: two-phase (on → fade) so the background transition animates out.
  const [flash, setFlash] = useState<{ seq: number; on: boolean } | null>(null)
  const consumedLocateRef = useRef<string | null>(null)
  // Suppress the auto-scroll-to-bottom effect around top-pagination prepends.
  const skipAutoScrollRef = useRef(false)
  // 「删除」= 仅对我删除(微信/飞书语义):不影响其他成员。P24 起服务端才是
  // 真相(拉历史时已删的行根本不回来),这份本地集合只做两件事:服务端回声
  // 到达前的乐观隐藏,以及 P24 之前的存量迁移。
  const [deletedMids, setDeletedMids] = useState<Set<number>>(new Set())
  useEffect(() => {
    let pending: number[] = []
    try {
      const raw = localStorage.getItem(`im:deleted:${cid}`)
      pending = raw ? (JSON.parse(raw) as number[]) : []
    } catch {
      pending = []
    }
    setDeletedMids(new Set(pending))
    if (!pending.length) return
    // 一次性迁移:把本设备的存量补发到服务端,成功后清 key。不做这步,老用户
    // 升级后历史删除会当场全部复活。失败就留着,下次进会话再试。
    try {
      client.deleteMessages(cid, pending)
      localStorage.removeItem(`im:deleted:${cid}`)
    } catch {
      // 未连上 / 写入失败 —— 保留本地那份,下次进会话重试。
    }
  }, [cid, client])
  // 渲染流:剔除控制消息(撤回墓碑 / 表情回复),它们不占气泡也不算时间间隔基准。
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => !CONTROL_TYPES.has(m.content_type) && !deletedMids.has(m.mid)
      ),
    [messages, deletedMids]
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // P4.1 群语音卡片: end-records (call-log carrying a slug) flip the matching
  // ongoing card to its ended state.
  const endedGroupCallSlugs = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages) {
      if (m.content_type !== 'call-log') continue
      try {
        const slug = (JSON.parse(m.body) as { slug?: string }).slug
        if (slug) set.add(slug)
      } catch {
        // ignore malformed bodies
      }
    }
    return set
  }, [messages])

  const groupCallSlugOf = (m: Message): string | null => {
    try {
      return (JSON.parse(m.body) as { slug?: string }).slug ?? null
    } catch {
      return null
    }
  }

  // Join a live group voice call from its card: resolve the room first — an
  // ended room issues no LiveKit token, which is the "already over" signal
  // (covers cards whose end-record sits outside the loaded window).
  const joinGroupCall = async (slug: string) => {
    if (callSnap.state.phase !== 'idle') return
    try {
      const room = await fetchApi<{ livekit?: { token?: string } }>(
        `rooms/${encodeURIComponent(slug)}/`
      )
      if (!room?.livekit?.token) {
        void showAlert({ message: t('call.groupCard.endedAlert') })
        return
      }
      navigateTo('room', slug, {
        state: { autoJoin: true, callAudioOnly: true, callMeet: true },
      })
    } catch {
      void showAlert({ message: t('call.groupCard.endedAlert') })
    }
  }

  // 已读回执(P13):每个成员的 last_read_seq;首次拉快照 + onRead 保活。
  const reads = useReadMarkers(client, cid)

  // Resolve member uids → display names + avatars. 群聊气泡显示发送人名字/头像;
  // 一对一也需解析对端头像(气泡左侧对方头像),否则 names 为空 → 头像退兜底、
  // nameOf 退成裸 uid。故不再限 isGroup,direct 的 [self, peer] 一并解析。
  const memberUids = conversation.members
  const { data: memberNames = {} } = useQuery({
    queryKey: ['im', 'member-names', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: memberUids.length > 0,
    staleTime: 60_000,
  })
  // P8-UX:退群成员的历史消息 —— sender 已不在 members,上面的查询覆盖不到,
  // 名字/头像会退成裸 uid +「0」兜底。把消息流里出现的「非成员 sender」单独
  // 批量解析(resolve 端点按组织过滤,不要求仍在会话内;SYSTEM 全零排除)。
  // Android 无此问题(UserDirectory 本就按消息 sender 惰性解析)。
  const extraSenderUids = useMemo(() => {
    const inMembers = new Set(memberUids)
    const out = new Set<string>()
    for (const m of messages) {
      if (
        m.sender_uid &&
        m.sender_uid !== IM_SYSTEM_UID &&
        !inMembers.has(m.sender_uid)
      ) {
        out.add(m.sender_uid)
      }
    }
    return [...out].sort()
  }, [messages, memberUids])
  const { data: extraNames = {} } = useQuery({
    queryKey: ['im', 'member-names-extra', cid, extraSenderUids],
    queryFn: () => resolveImUsers(extraSenderUids),
    enabled: extraSenderUids.length > 0,
    staleTime: 60_000,
  })
  // 现任成员优先(群昵称等语义不变),离群成员补位。
  const names = useMemo(
    () => ({ ...extraNames, ...memberNames }),
    [memberNames, extraNames]
  )
  // 机器人在 jusi 里是 role='bot',**不在** conversation.members —— 所以它走的
  // 是上面那条为「退群成员的历史消息」写的 extraSenderUids 分支,天然复用,
  // 这里只负责把身份取出来给气泡。
  const botOf = (uid: string): { description?: string } | undefined =>
    names[uid]?.is_bot ? { description: names[uid]?.description } : undefined
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
  // P17 Pin 集合(与 PinnedBar 共享同一查询缓存,onPin 事件在 PinnedBar 里失效)。
  const { data: pins = [] } = useQuery({
    queryKey: ['im', 'pins', cid],
    queryFn: () => client.listPins(cid),
    staleTime: 30_000,
  })
  const pinnedMids = useMemo(() => new Set(pins.map((p) => p.mid)), [pins])
  // For a sender's display: nickname → directory name → uid.
  const nameOf = useMemo(
    () => (uid: string) => nickOf[uid] || names[uid]?.full_name || uid,
    [nickOf, names]
  )
  // P10 离职标记。后端解析端点刻意不剔掉离职者(剔掉的话历史消息里的名字会退成
  // 裸 uid,比标一下糟得多),由客户端决定怎么表达。
  //
  // ⚠️ 后缀只能加在**纯渲染**的位置。`nameOf` 本身必须保持干净:它同时喂给
  // 引用条(`senderDisplay` → `replyTo.sender`)和合并转发快照(`sender_name`)
  // ——那两处会被**写进消息体发到服务端**,一旦带上「(已离职)」就永久冻在历史
  // 里,而且人复职了也改不回来。
  const leftOf = (uid: string): boolean => names[uid]?.left === true
  const nameWithDeparted = (uid: string): string =>
    leftOf(uid) ? `${nameOf(uid)}${t('departed.suffix')}` : nameOf(uid)

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

  // 图片消息(P7):收集图片 key 批量换 presigned GET URL。发送方先在本地 blobURL
  // 缓存里即时预览,resolve 回来的真实 URL 优先。
  const localImageUrls = useRef<Map<string, string>>(new Map())
  // All chat object keys in view: image bodies (= key) + file bodies (JSON.key).
  const fileKeyOf = (m: Message): string | undefined => {
    if (m.content_type !== 'file') return undefined
    try {
      return JSON.parse(m.body)?.key as string
    } catch {
      return undefined
    }
  }
  // 语音消息(P7-i):body=JSON{key, duration};key 走 file/ 前缀,resolve 复用。
  const voiceKeyOf = (m: Message): string | undefined => {
    if (m.content_type !== 'voice') return undefined
    try {
      return JSON.parse(m.body)?.key as string
    } catch {
      return undefined
    }
  }
  const voiceDurationOf = (m: Message): number | undefined => {
    if (m.content_type !== 'voice') return undefined
    try {
      return JSON.parse(m.body)?.duration as number
    } catch {
      return undefined
    }
  }
  const objectKeys = useMemo(() => {
    const s = new Set<string>()
    for (const m of messages) {
      if (m.content_type === 'image' && m.body) s.add(m.body)
      const fk = m.content_type === 'file' ? fileKeyOf(m) : undefined
      if (fk) s.add(fk)
      const vk = m.content_type === 'voice' ? voiceKeyOf(m) : undefined
      if (vk) s.add(vk)
    }
    return Array.from(s)
  }, [messages])
  const { data: resolvedUrls = {} } = useQuery({
    queryKey: ['im', 'object-urls', cid, objectKeys],
    queryFn: () => resolveChatImages(objectKeys),
    enabled: objectKeys.length > 0,
    staleTime: 50 * 60 * 1000, // < 服务端 1h presigned GET TTL
  })
  const imageUrlOf = (m: Message): string | undefined =>
    m.content_type === 'image'
      ? resolvedUrls[m.body] || localImageUrls.current.get(m.body)
      : undefined

  // 大图预览(P7-j):会话内所有已解析图片,按显示顺序;点击某张在 lightbox 打开。
  const imageList = useMemo(() => {
    const arr: Array<{ mid: number; url: string }> = []
    for (const m of visibleMessages) {
      if (m.content_type !== 'image') continue
      const u = resolvedUrls[m.body] || localImageUrls.current.get(m.body)
      if (u) arr.push({ mid: m.mid, url: u })
    }
    return arr
  }, [visibleMessages, resolvedUrls])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const openImage = (m: Message) => {
    const idx = imageList.findIndex((x) => x.mid === m.mid)
    if (idx >= 0) setLightboxIndex(idx)
  }
  const fileUrlOf = (m: Message): string | undefined => {
    const fk = fileKeyOf(m)
    return fk ? resolvedUrls[fk] : undefined
  }
  const voiceUrlOf = (m: Message): string | undefined => {
    const vk = voiceKeyOf(m)
    return vk ? resolvedUrls[vk] : undefined
  }

  // 发图片:上传 → 本地即时预览 → 发 content_type='image' 消息(body=object_key)。
  const onSendImage = async (file: File) => {
    try {
      const key = await uploadChatImage(file)
      localImageUrls.current.set(key, URL.createObjectURL(file))
      await client.sendText(cid, key, { contentType: 'image' })
    } catch (e) {
      const code = e instanceof ChatImageError ? e.code : 'uploadError'
      void showAlert({ message: t(`image.${code}`) })
    }
  }

  // 发文件:上传任意文件 → 发 content_type='file'、body=JSON{key,name,size}。
  const onSendFile = async (file: File) => {
    try {
      const meta = await uploadChatFile(file)
      await client.sendText(cid, JSON.stringify(meta), { contentType: 'file' })
    } catch (e) {
      const code = e instanceof ChatFileError ? e.code : 'uploadError'
      void showAlert({ message: t(`file.${code}`) })
    }
  }

  // 分享云文档到聊天(入口 A):选择器多选后逐个发 content_type='doc-card'。
  // 与 onSendImage/onSendFile 一致:发送失败弹提示(否则调用处 void 吞掉
  // rejection,断线时静默失败 + 后续文档不再发)。
  const onConfirmDocPicker = async (docs: MyDocumentHit[]) => {
    setShowDocPicker(false)
    try {
      for (const doc of docs) {
        await client.sendText(cid, buildDocCardBody(doc), {
          contentType: 'doc-card',
        })
        // 分享即精准授权:让当前会话成员点开卡片能直接看(best-effort)。
        // 这里不等结果——聊天里没有在看 docs 的成员列表,无需回刷。
        void grantDocAccess(doc.id, [cid])
      }
    } catch {
      void showAlert({ message: t('docPicker.sendError') })
    }
  }

  // 撤回:P16 起走服务端原生(消息自带 recalled 最终态 + msg-recalled 事件,
  // useMessages 已打进缓存);旧数据仍按 P7-c 客户端约定回放墓碑控制消息——
  // 双读,新操作不再发 content_type='recall'。
  const recalledMids = useMemo(() => {
    const s = new Set<number>()
    for (const m of messages) {
      if (m.recalled) {
        s.add(m.mid) // P16 native
        continue
      }
      if (m.content_type === 'recall') {
        try {
          const parsed = JSON.parse(m.body)
          if (typeof parsed?.target_mid === 'number') s.add(parsed.target_mid)
        } catch {
          // ignore malformed tombstone
        }
      }
    }
    return s
  }, [messages])

  const onRecall = async (m: Message) => {
    if (!(await askConfirm({ message: t('actions.recallConfirm') }))) return
    try {
      client.recall(cid, m.mid)
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 表情回复:P16 起消息自带 reactions 聚合快照(增量由 useMessages 打进缓存);
  // 旧数据仍按 P7-b 控制消息回放——双读合并(新旧数据无交集,不会重复计数)。
  // 新操作不再发 content_type='reaction'。
  const reactionsByMid = useMemo(() => {
    const map = new Map<number, ReactionState>()
    // P16 native snapshot.
    for (const m of messages) {
      if (!m.reactions?.length) continue
      const st: ReactionState = {}
      for (const g of m.reactions) st[g.emoji] = new Set(g.uids)
      map.set(m.mid, st)
    }
    // Legacy control-message replay (pre-P16 rows only).
    for (const m of messages) {
      if (m.content_type !== 'reaction') continue
      try {
        const { target_mid, emoji, op } = JSON.parse(m.body)
        if (typeof target_mid !== 'number' || typeof emoji !== 'string')
          continue
        let st = map.get(target_mid)
        if (!st) {
          st = {}
          map.set(target_mid, st)
        }
        if (!st[emoji]) st[emoji] = new Set()
        if (op === 'remove') st[emoji].delete(m.sender_uid)
        else st[emoji].add(m.sender_uid)
      } catch {
        // ignore malformed reaction
      }
    }
    return map
  }, [messages])

  // 反应人显示名(飞书式 chip 显示名字):自己→「我」,群→目录名,私聊→对端标题。
  const uidDisplay = (uid: string): string =>
    uid === currentUserUID ? t('group.you') : isGroup ? nameOf(uid) : title
  const reactionsFor = (mid: number): ReactionChip[] => {
    const st = reactionsByMid.get(mid)
    if (!st) return []
    return Object.entries(st)
      .filter(([, set]) => set.size > 0)
      .map(([emoji, set]) => {
        const names = [...set].map(uidDisplay)
        // 少量反应直接列名字(飞书风格),人多了改显计数避免 chip 过长。
        const label = names.length <= 5 ? names.join('、') : String(set.size)
        return { emoji, count: set.size, mine: set.has(currentUserUID), label }
      })
  }

  // 卡片按钮的叠加层(A2)。**它是唯一真相** —— ws 的 card-state 可能早于
  // 点击接口的响应到达,所以这里不做本地乐观状态,点完等服务端。
  const cardStateOf = useCardStates(messages)

  const onCardButton = async (m: Message, buttonId: string) => {
    // clickId 是幂等键:同一次点击重试带同一个值,服务端重放上次结果而不是
    // 再记一笔(与入站 webhook 的 X-Request-Id 同一个思路)。
    const clickId = `${m.mid}:${buttonId}:${crypto.randomUUID()}`
    try {
      await clickCardButton(m.mid, buttonId, clickId)
    } catch (e) {
      // 409 = 别人已经定局了。响应里带着当前状态,但我们这边统一靠下面这次
      // 失效重取 —— 少一条「响应体和 ws 谁先到」的分支要想。
      void showAlert({
        message: t('card.clickFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
    void queryClient.invalidateQueries({ queryKey: ['im', 'card-states'] })
  }

  const onReact = async (m: Message, emoji: string) => {
    const mine = !!reactionsByMid.get(m.mid)?.[emoji]?.has(currentUserUID)
    try {
      client.react(cid, m.mid, emoji, mine ? 'remove' : 'add')
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 引用回复(P7-b):选中一条消息 → 输入区上方显示引用条 → 发送时包成
  // content_type='quote'、body={reply_to:{sender,snippet}, text}。
  const [replyTo, setReplyTo] = useState<ReplyPreview | null>(null)
  const [draftText, setDraftText] = useState('')
  const draftTextRef = useRef('')
  const replyRef = useRef<ReplyPreview | null>(null)

  const persistDraft = (nextText: string, nextReply = replyRef.current) => {
    draftTextRef.current = nextText
    replyRef.current = nextReply
    setDraftText(nextText)
    const snapshot = nextReply
      ? {
          mid: nextReply.mid,
          sender: nextReply.sender,
          summary: nextReply.snippet,
        }
      : null
    writeLocalDraft(currentUserUID, cid, nextText, snapshot)
  }

  useEffect(() => {
    const local = readLocalDrafts(currentUserUID)[cid]
    const text = local?.text ?? ''
    draftTextRef.current = text
    setDraftText(text)
    const restored = local?.reply
      ? {
          mid: local.reply.mid,
          sender: local.reply.sender,
          snippet: local.reply.summary,
        }
      : null
    replyRef.current = restored
    setReplyTo(restored)
  }, [cid, currentUserUID])
  const senderDisplay = (m: Message): string =>
    m.sender_uid === currentUserUID
      ? t('group.you')
      : isGroup
        ? nameOf(m.sender_uid)
        : title
  const onReply = (m: Message) => {
    const reply = {
      mid: String(m.mid),
      sender: senderDisplay(m),
      snippet: snippetOf(m, t),
    }
    setReplyTo(reply)
    persistDraft(draftTextRef.current, reply)
  }

  // 多选合并转发(P7-f):右键「多选」进入选择模式 → 勾选多条 → 底部条选
  // 逐条转发 / 合并转发。合并把每条烘焙成 {发送人, 文本快照, 时间} 一次性打包。
  const [selectMode, setSelectMode] = useState(false)
  const [selectedMids, setSelectedMids] = useState<Set<number>>(new Set())
  const enterSelect = (m: Message) => {
    setSelectMode(true)
    setSelectedMids(new Set([m.mid]))
    setMenu(null)
  }
  const exitSelect = () => {
    setSelectMode(false)
    setSelectedMids(new Set())
  }

  // 删除的唯一落点:单条(右键菜单)与多选共用,只差数组长度。
  // P24:落到服务端(仅对我删除,多端同步),本地集合只是回声到达前的乐观隐藏。
  const applyDelete = (mids: number[]) => {
    client.deleteMessages(cid, mids)
    const next = new Set(deletedMids)
    for (const mid of mids) next.add(mid)
    setDeletedMids(next)
  }

  const handleDeleteSelected = async () => {
    const count = selectedMids.size
    if (count === 0) return
    const ok = await askConfirm({
      message: t('select.deleteConfirm', { count }),
      danger: true,
    })
    if (!ok) return
    try {
      applyDelete([...selectedMids])
      exitSelect()
    } catch (e) {
      await showAlert({
        message: t('select.deleteError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  const onDeleteOne = async (m: Message) => {
    if (
      !(await askConfirm({
        message: t('actions.deleteMessageConfirm'),
        danger: true,
      }))
    )
      return
    try {
      applyDelete([m.mid])
    } catch (e) {
      await showAlert({
        message: t('select.deleteError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }
  const toggleSelect = (mid: number) =>
    setSelectedMids((prev) => {
      const next = new Set(prev)
      if (next.has(mid)) next.delete(mid)
      else next.add(mid)
      return next
    })
  const selectedMessages = useMemo(
    () => visibleMessages.filter((m) => selectedMids.has(m.mid)),
    [visibleMessages, selectedMids]
  )
  // 合并记录里每条的纯文本表示:图片/文件/语音/记录 → 占位,文本/引用 → 全文。
  const mergedTextOf = (m: Message): string => {
    if (m.content_type === 'image') return t('preview.image')
    if (m.content_type === 'file') {
      try {
        return (JSON.parse(m.body)?.name as string) || t('preview.file')
      } catch {
        return t('preview.file')
      }
    }
    if (m.content_type === 'voice') return t('preview.voice')
    if (m.content_type === 'merged') return t('preview.merged')
    if (m.content_type === 'call-log') return t('preview.call')
    if (m.content_type === 'group-call') return t('preview.call')
    if (m.content_type === 'phone-viewed') return t('preview.phoneViewed')
    if (m.content_type === 'event-card') return t('preview.event')
    if (m.content_type === 'meeting-card') return t('preview.meeting')
    if (m.content_type === 'rich-text')
      return richTextPreview(m.body) || t('preview.richText')
    if (m.content_type === 'rich-card')
      return richCardPreview(m.body) || t('preview.richCard')
    if (m.content_type === 'quote') {
      try {
        return (JSON.parse(m.body)?.text as string) || ''
      } catch {
        return ''
      }
    }
    return m.body
  }
  const doForwardEach = () => {
    if (selectedMessages.length === 0) return
    onForwardMany?.({ mode: 'each', messages: selectedMessages })
    exitSelect()
  }
  const doForwardMerged = () => {
    if (selectedMessages.length === 0) return
    const items = selectedMessages.map((m) => ({
      sender: senderDisplay(m),
      text: mergedTextOf(m),
      ts: m.ts,
    }))
    const mergedTitle = isGroup
      ? t('merged.groupTitle')
      : t('merged.chatWith', { name: title })
    onForwardMany?.({
      mode: 'merged',
      merged: { title: mergedTitle, count: items.length, items },
    })
    exitSelect()
  }
  // 合并记录查看器:点开一条「聊天记录」卡片。
  const [mergedView, setMergedView] = useState<MergedBody | null>(null)
  const openMerged = (m: Message) => {
    try {
      const rec = JSON.parse(m.body) as MergedBody
      if (rec?.items) setMergedView(rec)
    } catch {
      // ignore malformed merged body
    }
  }

  // 右键上下文菜单(飞书式):快捷表情 + 复制 / 回复 / 撤回(自己 2 分钟内)。
  const [menu, setMenu] = useState<{
    x: number
    y: number
    message: Message
  } | null>(null)

  // 稍后处理:落库 + 失效 later 查询让入口 badge / 列表即时刷新。幂等 —
  // 重复标记服务端 get_or_create 吸收,已完成条目会被重新打开。
  const handleMarkLater = async (m: Message) => {
    try {
      await markLater({
        cid,
        mid: String(m.mid),
        seq: m.seq,
        snippet: snippetOf(m, t),
        sender_name: nameOf(m.sender_uid),
        content_type: m.content_type,
      })
      void queryClient.invalidateQueries({ queryKey: ['im', 'later'] })
    } catch (err) {
      void showAlert({
        message: t('later.error', {
          message: err instanceof Error ? err.message : String(err),
        }),
      })
    }
  }

  const buildMenuItems = (m: Message): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    // 复制:文本 / 引用(取回复正文);图片、文件不提供复制。
    if (
      m.content_type !== 'image' &&
      m.content_type !== 'file' &&
      m.content_type !== 'voice' &&
      m.content_type !== 'merged' &&
      m.content_type !== 'event-card' && // 复制裸 JSON 无意义
      m.content_type !== 'meeting-card' &&
      m.content_type !== 'calendar-card' &&
      m.body &&
      navigator.clipboard
    ) {
      const copyText = ['quote', 'rich-text', 'rich-card'].includes(
        m.content_type
      )
        ? snippetOf(m, t)
        : m.body
      items.push({
        key: 'copy',
        label: t('actions.copy'),
        onSelect: () => void navigator.clipboard.writeText(copyText),
      })
    }
    items.push({
      key: 'reply',
      label: t('actions.reply'),
      onSelect: () => onReply(m),
    })
    // 稍后处理(P3-M1,飞书式):个人书签,存 we-meet 侧,含快照(见 LaterDialog)。
    items.push({
      key: 'markLater',
      label: t('actions.markLater'),
      onSelect: () => void handleMarkLater(m),
    })
    // Pin(P17,会话共享):按当前状态切换文案;权限由服务端裁决。
    const pinned = pinnedMids.has(m.mid)
    items.push({
      key: 'pin',
      label: pinned ? t('actions.unpin') : t('actions.pin'),
      onSelect: () => {
        try {
          client.pin(cid, m.mid, pinned ? 'remove' : 'add')
        } catch {
          // not connected — PinnedBar stays as-is
        }
      },
    })
    // 转发(P7-e):text/image/file/quote 都可转发;system/control/已撤回不会
    // 走到这里(openMenu 已拦截)。
    if (onForward) {
      items.push({
        key: 'forward',
        label: t('actions.forward'),
        onSelect: () => onForward(m),
      })
    }
    // 多选(合并/逐条转发入口):进入选择模式并预选当前这条。
    if (onForwardMany) {
      items.push({
        key: 'multiSelect',
        label: t('actions.multiSelect'),
        onSelect: () => enterSelect(m),
      })
    }
    if (
      m.sender_uid === currentUserUID &&
      Date.now() - m.ts < RECALL_WINDOW_MS
    ) {
      items.push({
        key: 'recall',
        label: t('actions.recall'),
        danger: true,
        onSelect: () => void onRecall(m),
      })
    }
    // 删除(仅本端,不限发送者):和多选删除同一条路径,只是一次一条。
    items.push({
      key: 'delete',
      label: t('actions.deleteMessage'),
      danger: true,
      onSelect: () => void onDeleteOne(m),
    })
    return items
  }

  const openMenu = (e: React.MouseEvent, m: Message) => {
    // Control / system / already-recalled rows have no menu → native menu shows.
    if (
      m.content_type === 'system' ||
      m.content_type === 'call-log' ||
      CONTROL_TYPES.has(m.content_type) ||
      recalledMids.has(m.mid)
    ) {
      return
    }
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, message: m })
  }

  // Auto-scroll on new message. Suppressed while anchored behind the tail
  // (P1-M2: the user is reading history) and around top-pagination prepends
  // (the scroll offset is restored manually instead).
  useEffect(() => {
    if (activeAnchor && !caughtUp) return
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false
      return
    }
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // P1-M2 定位: once the anchored window is in, scroll the target row into
  // view (center) and flash it. Consumed once per locate nonce; a missing row
  // (deleted locally / hidden control type) falls back to the bottom.
  useEffect(() => {
    if (!activeAnchor || isLoading || messages.length === 0) return
    if (consumedLocateRef.current === activeAnchor.key) return
    consumedLocateRef.current = activeAnchor.key
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(
        `[data-seq="${activeAnchor.seq}"]`
      ) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ block: 'center' })
        setFlash({ seq: activeAnchor.seq, on: true })
        setTimeout(() => setFlash((f) => (f ? { ...f, on: false } : f)), 900)
        setTimeout(() => setFlash(null), 2600)
      } else {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      }
      // Probe the tail once: when the anchor sits inside the newest page this
      // flips caughtUp immediately (live append + markRead resume) instead of
      // waiting for a bottom-scroll.
      void loadNewer()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAnchor, isLoading, messages.length])

  // Mark the latest seq read whenever we render a non-empty view — but NOT
  // while an anchored window lags behind the tail (its last row isn't the
  // real latest; reporting it could regress the read marker).
  useEffect(() => {
    if (messages.length === 0 || !caughtUp) return
    const latest = messages[messages.length - 1]
    if (latest && latest.seq > 0) {
      void client.markRead(cid, latest.seq).catch(() => {
        // best-effort; the marker will catch up on the next render
      })
    }
  }, [client, cid, messages, caughtUp])

  // P1-M2 双向翻页: top → prepend an older page (scroll offset restored so
  // the view doesn't jump); bottom while anchored → pull the next newer page
  // until the live tail is reached.
  const onScrollPane = async () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop <= 40 && hasMoreOlder && !isLoading) {
      const prevHeight = el.scrollHeight
      const prevTop = el.scrollTop
      skipAutoScrollRef.current = true
      const prepended = await loadOlder()
      if (prepended) {
        requestAnimationFrame(() => {
          el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
        })
      }
    }
    if (
      activeAnchor &&
      !caughtUp &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 80
    ) {
      skipAutoScrollRef.current = true
      void loadNewer()
    }
  }

  // 已读回执(P13):回执只挂在「自己发的、未被撤回的最新一条」消息上(飞书/微信式),
  // 避免每条气泡都堆一行。读标记单调,故最新一条的状态足以代表全部。
  const peerUid = isGroup
    ? undefined
    : memberUids.find((u) => u !== currentUserUID)
  /** 私聊对端已离职 —— 头部标题下方给一行提示,免得对着空账号发消息。 */
  const peerLeft = !!peerUid && leftOf(peerUid)
  const lastOwnMid = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]
      if (m.sender_uid === currentUserUID && !recalledMids.has(m.mid)) {
        return m.mid
      }
    }
    return null
  }, [visibleMessages, currentUserUID, recalledMids])

  // 群聊名单弹窗:记录被点开回执的目标消息 seq(据此把成员分已读 / 未读)。
  const [readListSeq, setReadListSeq] = useState<number | null>(null)
  // P4.1 群语音通话 / P5.1 群视频会议: member picker visibility + media.
  // Both ride the same picker → startGroupVoiceCall ringing pipeline; video
  // additionally reports every group member as a suggested participant and
  // lands everyone in the full meeting UI (修复实测问题1/2: 群视频原快速会议
  // 路径不振铃、不进建议参会名单)。
  const [groupCallMedia, setGroupCallMedia] = useState<
    'audio' | 'video' | null
  >(null)

  const receiptFor = (
    m: Message
  ):
    | { label: string; clickable?: boolean; onClick?: () => void }
    | undefined => {
    if (m.mid !== lastOwnMid || m.seq <= 0) return undefined
    if (!isGroup) {
      if (!peerUid) return undefined
      const read = (reads[peerUid] ?? 0) >= m.seq
      return { label: read ? t('read.read') : t('read.unread') }
    }
    const others = memberUids.filter((u) => u !== currentUserUID)
    if (others.length === 0) return undefined
    const readCount = others.filter((u) => (reads[u] ?? 0) >= m.seq).length
    const label =
      readCount === 0
        ? t('read.groupNone')
        : readCount >= others.length
          ? t('read.groupAll')
          : t('read.groupCount', { count: readCount })
    return { label, clickable: true, onClick: () => setReadListSeq(m.seq) }
  }

  // 名单成员按目标 seq 分已读 / 未读(排除自己)。
  const readListMembers = useMemo(() => {
    if (readListSeq == null) return null
    const read: ReadReceiptMember[] = []
    const unread: ReadReceiptMember[] = []
    for (const u of memberUids) {
      if (u === currentUserUID) continue
      const entry: ReadReceiptMember = {
        uid: u,
        name: nameOf(u),
        avatarUrl: names[u]?.avatar_url,
      }
      if ((reads[u] ?? 0) >= readListSeq) read.push(entry)
      else unread.push(entry)
    }
    return { read, unread }
  }, [readListSeq, memberUids, currentUserUID, reads, nameOf, names])

  const onSend = async (text: string) => {
    if (replyTo) {
      await client.sendText(cid, JSON.stringify({ reply_to: replyTo, text }), {
        contentType: 'quote',
      })
      setReplyTo(null)
    } else {
      await client.sendText(cid, text)
    }
    writeLocalDraft(currentUserUID, cid, '', null)
    draftTextRef.current = ''
    setDraftText('')
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
          {/* 私聊对端已离职:提示写在标题下方,与群聊的成员数同一行位。不把
              「(已离职)」拼进 `title` —— title 会顺着 peerName / roomName 流进
              通话与会议室命名,那些地方不该带这个后缀。 */}
          {peerLeft && (
            <div
              className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}
            >
              {t('departed.hint')}
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
        {/* P4.1 群语音通话: member picker → parallel ringing invites. */}
        {isGroup && (
          <button
            type="button"
            onClick={() => setGroupCallMedia('audio')}
            disabled={callSnap.state.phase !== 'idle'}
            title={t('call.groupPicker.title')}
            aria-label={t('call.groupPicker.title')}
            data-testid="chat-group-voice-call"
            className={headerBtn}
          >
            <RiPhoneLine size={16} />
          </button>
        )}
        {/* P5.1 群视频会议: same picker → ring members into the full meeting
            UI (替代原快速会议路径——那条不振铃也不落建议参会名单)。 */}
        {isGroup && (
          <button
            type="button"
            onClick={() => setGroupCallMedia('video')}
            disabled={callSnap.state.phase !== 'idle'}
            title={t('call.groupMeeting')}
            aria-label={t('call.groupMeeting')}
            data-testid="chat-group-meeting"
            className={headerBtn}
          >
            <RiVidiconLine size={16} />
          </button>
        )}
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
            title={t('manage.settings')}
            aria-label={t('manage.settings')}
            data-testid="chat-group-info"
            className={headerBtn}
          >
            ⋯
          </button>
        )}
        {/* P1 一对一通话: voice / video call from the direct-chat header.
            Buttons no-op while a call is already active (backstopped in the
            controller too); the CallOverlay in ImUnreadProvider renders the
            outgoing UI once the state machine leaves idle. */}
        {!isGroup && peerUid && (
          <>
            <button
              type="button"
              onClick={() =>
                void startCall({
                  cid,
                  peerUid,
                  peerName: title,
                  peerAvatar: names[peerUid]?.avatar_url,
                  media: 'audio',
                  roomName: t('call.roomName', { name: title }),
                  username: user?.full_name ?? '',
                })
              }
              disabled={callSnap.state.phase !== 'idle'}
              title={t('call.voice')}
              aria-label={t('call.voice')}
              data-testid="chat-voice-call"
              className={headerBtn}
            >
              <RiPhoneLine size={16} />
            </button>
            <button
              type="button"
              onClick={() =>
                void startCall({
                  cid,
                  peerUid,
                  peerName: title,
                  peerAvatar: names[peerUid]?.avatar_url,
                  media: 'video',
                  roomName: t('call.roomName', { name: title }),
                  username: user?.full_name ?? '',
                })
              }
              disabled={callSnap.state.phase !== 'idle'}
              title={t('call.video')}
              aria-label={t('call.video')}
              data-testid="chat-video-call"
              className={headerBtn}
            >
              <RiVidiconLine size={16} />
            </button>
          </>
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
          {/* P17 Pin 栏:有 Pin 时置于头部下方,点击展开完整列表。 */}
          <PinnedBar
            client={client}
            cid={cid}
            nameOf={nameOf}
            // P3-M3 后补: 点置顶条目 → 复用 P1-M2 锚定定位(nonce 保证重复点击生效)。
            onJump={(seq) =>
              setAnchor({ seq, key: `pin-${seq}-${Date.now()}`, cid })
            }
          />
          <div
            ref={scrollRef}
            onScroll={() => void onScrollPane()}
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
              visibleMessages.map((m, idx) => {
                const prev = visibleMessages[idx - 1]
                const showDivider =
                  idx === 0 || m.ts - prev.ts >= TIME_DIVIDER_GAP_MS
                const isOwnMsg = m.sender_uid === currentUserUID
                return (
                  <Fragment key={m.mid}>
                    {showDivider && (
                      <TimeDivider
                        label={fmtDivider(
                          m.ts,
                          i18n.language,
                          t('time.yesterday')
                        )}
                      />
                    )}
                    {/* data-seq: P1-M2 定位锚点;flash 用背景过渡渐隐。 */}
                    <div
                      data-seq={m.seq}
                      style={
                        flash?.seq === m.seq
                          ? {
                              backgroundColor: flash.on
                                ? 'rgba(255, 213, 79, 0.35)'
                                : 'transparent',
                              transition: 'background-color 1.6s ease-out',
                            }
                          : undefined
                      }
                    >
                      <MessageItem
                        message={m}
                        isOwn={isOwnMsg}
                        senderName={
                          isOwnMsg
                            ? user?.full_name || selfName || currentUserUID
                            : nameWithDeparted(m.sender_uid)
                        }
                        senderAvatarUrl={
                          isOwnMsg
                            ? user?.avatar_url || undefined
                            : names[m.sender_uid]?.avatar_url
                        }
                        senderBot={botOf(m.sender_uid)}
                        imageUrl={imageUrlOf(m)}
                        fileUrl={fileUrlOf(m)}
                        voiceUrl={voiceUrlOf(m)}
                        voiceDurationMs={voiceDurationOf(m)}
                        reactions={reactionsFor(m.mid)}
                        cardState={cardStateOf(m.mid)}
                        onCardButton={(buttonId) =>
                          void onCardButton(m, buttonId)
                        }
                        onReact={(emoji) => void onReact(m, emoji)}
                        recalled={recalledMids.has(m.mid)}
                        onContextMenu={(e) => openMenu(e, m)}
                        onImageClick={() => openImage(m)}
                        onMergedClick={() => openMerged(m)}
                        selectMode={selectMode}
                        selected={selectedMids.has(m.mid)}
                        onToggleSelect={() => toggleSelect(m.mid)}
                        showSender={isGroup}
                        mentionNames={highlightNames}
                        selfMentionNames={[selfName, everyone].filter(Boolean)}
                        readReceipt={isOwnMsg ? receiptFor(m) : undefined}
                        onAvatarClick={
                          !selectMode && names[m.sender_uid]?.id
                            ? () => onMemberClick?.(names[m.sender_uid]!.id!)
                            : undefined
                        }
                        onOpenEvent={selectMode ? undefined : setViewEventId}
                        onOpenDoc={
                          selectMode
                            ? undefined
                            : (card) => navigateTo('docs', card.doc_id)
                        }
                        onJoinGroupCall={
                          m.content_type === 'group-call' && groupCallSlugOf(m)
                            ? () => void joinGroupCall(groupCallSlugOf(m)!)
                            : undefined
                        }
                        groupCallEnded={
                          m.content_type === 'group-call'
                            ? (() => {
                                const s = groupCallSlugOf(m)
                                return !s || endedGroupCallSlugs.has(s)
                              })()
                            : undefined
                        }
                      />
                    </div>
                  </Fragment>
                )
              })
            )}
          </div>
          {/* P1-M2: while the anchored window lags behind the tail, offer a
              one-tap way back to the live view. */}
          {activeAnchor && !caughtUp && (
            <div className={jumpLatestWrap}>
              <button
                type="button"
                onClick={() => setAnchor(null)}
                data-testid="chat-jump-latest"
                className={jumpLatestBtn}
              >
                {t('chat.jumpToLatest')}
              </button>
            </div>
          )}
          {selectMode ? (
            <div className={selectBarCls}>
              <button
                type="button"
                onClick={exitSelect}
                data-testid="select-cancel"
                className={selectBtnCls(true)}
              >
                {t('group.cancel')}
              </button>
              <span
                className={css({
                  flex: 1,
                  fontSize: '0.875rem',
                  color: 'greyscale.600',
                })}
              >
                {t('select.count', { count: selectedMids.size })}
              </span>
              <button
                type="button"
                disabled={selectedMids.size === 0}
                onClick={doForwardEach}
                data-testid="select-forward-each"
                className={selectBtnCls(selectedMids.size > 0)}
              >
                {t('select.forwardEach')}
              </button>
              <button
                type="button"
                disabled={selectedMids.size === 0}
                onClick={doForwardMerged}
                data-testid="select-forward-merged"
                className={selectBtnCls(selectedMids.size > 0)}
              >
                {t('select.forwardMerged')}
              </button>
              <button
                type="button"
                disabled={selectedMids.size === 0}
                onClick={handleDeleteSelected}
                data-testid="select-delete"
                className={selectBtnCls(selectedMids.size > 0, true)}
              >
                {t('select.delete')}
              </button>
            </div>
          ) : (
            <MessageInput
              key={cid}
              onSend={onSend}
              onSendImage={onSendImage}
              onSendFile={onSendFile}
              onSendDoc={() => setShowDocPicker(true)}
              reply={replyTo}
              onCancelReply={() => {
                setReplyTo(null)
                persistDraft(draftTextRef.current, null)
              }}
              disabled={sendDisabled}
              mentionables={mentionables}
              initialText={draftText}
              onDraftChange={(value) => persistDraft(value)}
              recentEmojis={recentEmojis}
              customEmojis={customEmojis}
              onRecentEmoji={rememberEmoji}
              onSendCustomEmoji={async (emoji) => {
                await client.sendText(cid, emoji.key, { contentType: 'image' })
              }}
              conversationType={isGroup ? 'group' : 'direct'}
              onCommand={(command) => {
                if (command === 'schedule') onOpenCalendar?.()
                else if (command === 'document') setShowDocPicker(true)
                else if (command === 'voice-meeting') setGroupCallMedia('audio')
                else if (command === 'voice-call' && peerUid) {
                  void startCall({
                    cid,
                    peerUid,
                    peerName: title,
                    peerAvatar: names[peerUid]?.avatar_url,
                    media: 'audio',
                    roomName: t('call.roomName', { name: title }),
                    username: user?.full_name ?? '',
                  })
                } else if (command === 'video-meeting')
                  setGroupCallMedia('video')
                else if (command === 'video-call' && peerUid) {
                  void startCall({
                    cid,
                    peerUid,
                    peerName: title,
                    peerAvatar: names[peerUid]?.avatar_url,
                    media: 'video',
                    roomName: t('call.roomName', { name: title }),
                    username: user?.full_name ?? '',
                  })
                }
              }}
            />
          )}
        </div>
        {infoPanel}
      </div>
      {menu && (
        <MessageContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.message)}
          reactionEmojis={REACTION_EMOJIS}
          onReact={(emoji) => void onReact(menu.message, emoji)}
          onClose={() => setMenu(null)}
        />
      )}
      <ImageLightbox
        images={imageList.map((x) => x.url)}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
      {readListMembers && (
        <ReadReceiptList
          read={readListMembers.read}
          unread={readListMembers.unread}
          onClose={() => setReadListSeq(null)}
        />
      )}
      {mergedView && (
        <MergedRecordDialog
          record={mergedView}
          onClose={() => setMergedView(null)}
        />
      )}
      {groupCallMedia && (
        <GroupVoiceCallPicker
          client={client}
          cid={cid}
          title={
            groupCallMedia === 'video'
              ? t('call.groupPicker.videoTitle')
              : undefined
          }
          onClose={() => setGroupCallMedia(null)}
          onCall={(targets, allMembers) =>
            void startGroupVoiceCall({
              groupCid: cid,
              roomName:
                groupCallMedia === 'video'
                  ? t('call.groupMeetingRoomName', { name: title })
                  : t('call.groupCallRoomName', { name: title }),
              username: user?.full_name ?? '',
              targets,
              media: groupCallMedia,
              // P5 建议参会: whole group roster, not just the picked ones.
              suggestUserIds: allMembers.map((m) => m.userId),
            })
          }
        />
      )}
      {viewEventId && (
        <EventDetailHost
          eventId={viewEventId}
          onClose={() => setViewEventId(null)}
        />
      )}
      {showDocPicker && (
        <DocPickerDialog
          onConfirm={(docs) => void onConfirmDocPicker(docs)}
          onClose={() => setShowDocPicker(false)}
        />
      )}
    </div>
  )
}

// 多选底部操作条:取消 · 已选 N · 逐条转发 · 合并转发(飞书式)。
const selectBarCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})

const selectBtnCls = (enabled: boolean, primary = false) =>
  css({
    flexShrink: 0,
    paddingX: '1rem',
    paddingY: '0.5rem',
    borderRadius: '0.5rem',
    border: primary ? 'none' : '1px solid token(colors.greyscale.300)',
    backgroundColor: primary
      ? enabled
        ? 'primary.500'
        : 'greyscale.300'
      : 'transparent',
    color: primary ? 'white' : 'greyscale.700',
    fontSize: '0.875rem',
    fontWeight: 'medium',
    cursor: enabled ? 'pointer' : 'not-allowed',
    _hover: primary ? {} : { backgroundColor: 'greyscale.100' },
  })

/* P1-M2 定位: floating "跳至最新" pill above the input while the anchored
 * window lags behind the live tail. */
const jumpLatestWrap = css({
  position: 'relative',
  height: 0,
  display: 'flex',
  justifyContent: 'center',
})
const jumpLatestBtn = css({
  position: 'absolute',
  bottom: '0.5rem',
  padding: '0.375rem 0.875rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'primary.600',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  _hover: { backgroundColor: 'greyscale.100' },
})

const headerBtn = css({
  flexShrink: 0,
  width: '2rem',
  height: '2rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '999px',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '1rem',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  _hover: { backgroundColor: 'greyscale.100' },
})
