import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { Client, ConversationSummary, Message } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { useConfirm } from '@/components/ConfirmProvider'

import { resolveImUsers } from '../api/resolveImUsers'
import { resolveChatImages } from '../api/resolveChatImages'
import { uploadChatImage, ChatImageError } from '../api/uploadChatImage'
import { uploadChatFile, ChatFileError } from '../api/uploadChatFile'
import { uploadChatVoice, ChatVoiceError } from '../api/uploadChatVoice'
import { deleteMessages } from '../api/deleteMessages'
import { MessageInput, type ReplyPreview } from '../components/MessageInput'
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

// Recall is allowed only on your own messages within this window (WeChat: 2 min).
const RECALL_WINDOW_MS = 2 * 60 * 1000

// Quick-reaction emojis offered in the message context menu.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// Control message types that never render as a chat bubble (filtered from the
// stream; they drive recall / reaction aggregation instead).
const CONTROL_TYPES = new Set(['recall', 'reaction'])

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
  if (m.content_type === 'image') return t('preview.image')
  if (m.content_type === 'file') return t('preview.file')
  if (m.content_type === 'voice') return t('preview.voice')
  if (m.content_type === 'merged') return t('preview.merged')
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
  onForward,
  onForwardMany,
  infoPanel,
}: Props) => {
  const { t, i18n } = useTranslation('im')
  const { user } = useUser()
  const { alert: showAlert, confirm: askConfirm } = useConfirm()
  const cid = conversation.cid
  const isGroup = conversation.type === 'group'
  const { data: messages = [], isLoading } = useMessages(client, cid)
  // Client-side deleted mids — cleared when switching conversations.
  const [deletedMids, setDeletedMids] = useState<Set<number>>(new Set())
  useEffect(() => setDeletedMids(new Set()), [cid])
  // 渲染流:剔除控制消息(撤回墓碑 / 表情回复),它们不占气泡也不算时间间隔基准。
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => !CONTROL_TYPES.has(m.content_type) && !deletedMids.has(m.mid)
      ),
    [messages, deletedMids]
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 已读回执(P13):每个成员的 last_read_seq;首次拉快照 + onRead 保活。
  const reads = useReadMarkers(client, cid)

  // Resolve member uids → display names + avatars. 群聊气泡显示发送人名字/头像;
  // 一对一也需解析对端头像(气泡左侧对方头像),否则 names 为空 → 头像退兜底、
  // nameOf 退成裸 uid。故不再限 isGroup,direct 的 [self, peer] 一并解析。
  const memberUids = conversation.members
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: memberUids.length > 0,
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

  // 发语音(P7-i):录音 blob 复用文件直传(audio 也是文件,file/ 前缀 resolve 通用),
  // 发 content_type='voice'、body=JSON{key, duration}。
  const onSendVoice = async (blob: Blob, durationMs: number) => {
    try {
      const key = await uploadChatVoice(blob)
      await client.sendText(
        cid,
        JSON.stringify({ key, duration: durationMs }),
        { contentType: 'voice' }
      )
    } catch (e) {
      const code = e instanceof ChatVoiceError ? e.code : 'uploadError'
      void showAlert({ message: t(`file.${code}`) })
    }
  }

  // 撤回(P7-c):墓碑协议消息 content_type='recall'、body={target_mid}。所有端
  // (含历史加载)据此把原消息渲染成「已撤回」;墓碑本身在列表里过滤掉,不显示。
  const recalledMids = useMemo(() => {
    const s = new Set<number>()
    for (const m of messages) {
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
      await client.sendText(cid, JSON.stringify({ target_mid: m.mid }), {
        contentType: 'recall',
      })
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 表情回复(P7-b):控制消息 content_type='reaction'、body={target_mid,emoji,op}。
  // 按 seq 顺序回放 add/remove 聚合成每条消息的表情集合;控制消息本身不入消息流。
  const reactionsByMid = useMemo(() => {
    const map = new Map<number, ReactionState>()
    for (const m of messages) {
      if (m.content_type !== 'reaction') continue
      try {
        const { target_mid, emoji, op } = JSON.parse(m.body)
        if (typeof target_mid !== 'number' || typeof emoji !== 'string') continue
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
    uid === currentUserUID
      ? t('group.you')
      : isGroup
        ? nameOf(uid)
        : title
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

  const onReact = async (m: Message, emoji: string) => {
    const mine = !!reactionsByMid.get(m.mid)?.[emoji]?.has(currentUserUID)
    try {
      await client.sendText(
        cid,
        JSON.stringify({ target_mid: m.mid, emoji, op: mine ? 'remove' : 'add' }),
        { contentType: 'reaction' }
      )
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
  const senderDisplay = (m: Message): string =>
    m.sender_uid === currentUserUID
      ? t('group.you')
      : isGroup
        ? nameOf(m.sender_uid)
        : title
  const onReply = (m: Message) => {
    setReplyTo({ sender: senderDisplay(m), snippet: snippetOf(m, t) })
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

  const handleDeleteSelected = async () => {
    const count = selectedMids.size
    if (count === 0) return
    const ok = await askConfirm({
      message: t('select.deleteConfirm', { count }),
      danger: true,
    })
    if (!ok) return
    try {
      await deleteMessages(cid, [...selectedMids].map(String))
      // Filter deleted mids from the local message list immediately.
      setDeletedMids((prev) => {
        const next = new Set(prev)
        for (const mid of selectedMids) next.add(mid)
        return next
      })
      exitSelect()
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
  const [menu, setMenu] = useState<{ x: number; y: number; message: Message } | null>(
    null
  )

  const buildMenuItems = (m: Message): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    // 复制:文本 / 引用(取回复正文);图片、文件不提供复制。
    if (
      m.content_type !== 'image' &&
      m.content_type !== 'file' &&
      m.content_type !== 'voice' &&
      m.content_type !== 'merged' &&
      m.body &&
      navigator.clipboard
    ) {
      const copyText = m.content_type === 'quote' ? snippetOf(m, t) : m.body
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
    return items
  }

  const openMenu = (e: React.MouseEvent, m: Message) => {
    // Control / system / already-recalled rows have no menu → native menu shows.
    if (
      m.content_type === 'system' ||
      CONTROL_TYPES.has(m.content_type) ||
      recalledMids.has(m.mid)
    ) {
      return
    }
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, message: m })
  }

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

  // 已读回执(P13):回执只挂在「自己发的、未被撤回的最新一条」消息上(飞书/微信式),
  // 避免每条气泡都堆一行。读标记单调,故最新一条的状态足以代表全部。
  const peerUid = isGroup
    ? undefined
    : memberUids.find((u) => u !== currentUserUID)
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

  const receiptFor = (
    m: Message
  ): { label: string; clickable?: boolean; onClick?: () => void } | undefined => {
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
      await client.sendText(
        cid,
        JSON.stringify({ reply_to: replyTo, text }),
        { contentType: 'quote' }
      )
      setReplyTo(null)
    } else {
      await client.sendText(cid, text)
    }
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
                    <MessageItem
                      message={m}
                      isOwn={isOwnMsg}
                      senderName={
                        isOwnMsg
                          ? user?.full_name || selfName || currentUserUID
                          : nameOf(m.sender_uid)
                      }
                      senderAvatarUrl={
                        isOwnMsg
                          ? user?.avatar_url || undefined
                          : names[m.sender_uid]?.avatar_url
                      }
                      imageUrl={imageUrlOf(m)}
                      fileUrl={fileUrlOf(m)}
                      voiceUrl={voiceUrlOf(m)}
                      voiceDurationMs={voiceDurationOf(m)}
                      reactions={reactionsFor(m.mid)}
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
                    />
                  </Fragment>
                )
              })
            )}
          </div>
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
              <span className={css({ flex: 1, fontSize: '0.875rem', color: 'greyscale.600' })}>
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
              onSend={onSend}
              onSendImage={onSendImage}
              onSendFile={onSendFile}
              onSendVoice={onSendVoice}
              reply={replyTo}
              onCancelReply={() => setReplyTo(null)}
              disabled={sendDisabled}
              mentionables={mentionables}
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
