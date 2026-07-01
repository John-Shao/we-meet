import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'

import { ContactPicker } from '@/features/contacts'
import type { DirectoryMember } from '@/features/contacts'
import type { ConversationSummary, ConvMember, Message } from '@jusi/light-im-sdk'

import { createDirectConversationByUserId } from '../api/createDirectConversation'
import { createGroupConversation } from '../api/createGroupConversation'
import { resolveImUsers } from '../api/resolveImUsers'
import { fetchImToken } from '../api/fetchImToken'
import { ChatPane } from './ChatPane'
import { AddMemberDialog } from '../components/AddMemberDialog'
import { ConnectionStatusBar } from '../components/ConnectionStatusBar'
import { ConversationList } from '../components/ConversationList'
import { GroupMembersPanel } from '../components/GroupMembersPanel'
import { GroupSettingsPanel } from '../components/GroupSettingsPanel'
import { DirectSettingsPanel } from '../components/DirectSettingsPanel'
import { GroupPicker } from '../components/GroupPicker'
import { ForwardDialog, type ForwardConv } from '../components/ForwardDialog'
import type { MergedBody } from '../components/MergedRecordDialog'
import { useConversations } from '../hooks/useConversations'
import { useImConnection } from '../hooks/useImConnection'

/**
 * `/im` route — split view: conversation list (left) + chat pane (right).
 *
 * Behaviour:
 *   - Not logged in: render an inline prompt (auth guard at the router layer would
 *     also redirect to Keycloak; this branch handles the brief in-between).
 *   - Logged in: mount the SDK Client (singleton), render status + list + (optionally) chat.
 *   - Selecting a conversation lazily loads its history via React Query.
 */
export const ImRoute = () => (
  <RequireAuth>
    <Screen>
      <ImAuthenticated />
    </Screen>
  </RequireAuth>
)

const ImAuthenticated = () => {
  const { t } = useTranslation('im')
  const { user } = useUser()
  const { client, state } = useImConnection()
  const { data: tokenData } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    staleTime: 60_000,
  })
  const currentUserUID = tokenData?.uid ?? ''
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const [groupSeed, setGroupSeed] = useState<
    Array<{ id: string; label: string }>
  >([])
  // Server returns conversations pinned-first (P10); the list renders as-is and
  // reads pinned/muted off each summary.
  const { data: conversations = [], isLoading: convLoading } = useConversations(
    client,
    currentUserUID
  )
  // 从通讯录跳来时 URL 带 ?cid=<会话>,直接预选并打开该会话。
  const [searchParams] = useSearchParams()
  const initialCID = searchParams.get('cid')
  const [selectedCID, setSelectedCID] = useState<string | null>(initialCID)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  // Right-side panel below the chat header: 群成员 / 群设置 / 收起。Mutually
  // exclusive — opening one collapses the other.
  const [rightPanel, setRightPanel] = useState<'members' | 'settings' | null>(
    null
  )
  const [addOpen, setAddOpen] = useState(false)
  // 转发(P7-e):右键选中的待转发消息;非空时弹出目标会话选择器。
  const [forwarding, setForwarding] = useState<Message | null>(null)
  // 多选转发(P7-f):逐条或合并;非空时同样弹目标选择器。
  const [forwardingMany, setForwardingMany] = useState<
    | { mode: 'each'; messages: Message[] }
    | { mode: 'merged'; merged: MergedBody }
    | null
  >(null)
  // cids with an unread message that @-mentioned me (red "@" marker in the list).
  const [mentionedCids, setMentionedCids] = useState<Set<string>>(new Set())
  const qc = useQueryClient()

  // Per-conversation mute flags, kept in a ref so the once-registered onMessage
  // listener reads the latest without re-subscribing on every list refetch (P10).
  const muteFlagsRef = useRef<
    Map<string, { muted: boolean; muteAtAll: boolean }>
  >(new Map())
  useEffect(() => {
    const m = new Map<string, { muted: boolean; muteAtAll: boolean }>()
    for (const c of conversations) {
      m.set(c.cid, { muted: !!c.muted, muteAtAll: !!c.mute_at_all })
    }
    muteFlagsRef.current = m
  }, [conversations])

  // 带 cid 进来时刷新会话列表,让新建/已存在的会话出现在左栏(ChatPane 本身已按 cid 渲染)。
  useEffect(() => {
    if (initialCID) {
      setSelectedCID(initialCID)
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    }
  }, [initialCID, qc])

  // 被 @ 提醒:收到他人消息且 @我自己 或 @所有人、且不在当前会话 → 列表标红「@」。
  // 免打扰(muted)整会话不亮;@所有人不提示(mute_at_all)只屏蔽纯 @所有人,
  // 单独 @我仍亮(P10)。
  const selfName = user?.full_name || ''
  const everyone = t('mention.everyone')
  useEffect(() => {
    const off = client.onMessage((m) => {
      if (m.sender_uid === currentUserUID || m.cid === selectedCID) return
      const flags = muteFlagsRef.current.get(m.cid)
      if (flags?.muted) return // 消息免打扰:完全不亮
      const body = m.body || ''
      // Others @ me by my group nickname (if set) — read it from the cached
      // roster; match either nickname or directory name (P10).
      const roster = qc.getQueryData<ConvMember[]>(['im', 'members', m.cid])
      const myNick = roster?.find((r) => r.uid === currentUserUID)?.nickname
      const mentionsSelf =
        (!!myNick && body.includes(`@${myNick}`)) ||
        (!!selfName && body.includes(`@${selfName}`))
      const mentionsAll = body.includes(`@${everyone}`)
      const notify = mentionsSelf || (mentionsAll && !flags?.muteAtAll)
      if (notify) {
        setMentionedCids((prev) => {
          if (prev.has(m.cid)) return prev
          const next = new Set(prev)
          next.add(m.cid)
          return next
        })
      }
    })
    return off
  }, [client, currentUserUID, selectedCID, selfName, everyone, qc])

  // Opening a conversation clears its @ marker.
  useEffect(() => {
    if (!selectedCID) return
    setMentionedCids((prev) => {
      if (!prev.has(selectedCID)) return prev
      const next = new Set(prev)
      next.delete(selectedCID)
      return next
    })
  }, [selectedCID])

  // 被群主踢出时,服务端定向推一条 system 帧(P9)。掉群:从列表移除、若正打开则关闭并提示。
  useEffect(() => {
    const off = client.onSystem((s) => {
      if (s?.event !== 'removed_from_conversation') return
      const removedCid = typeof s.cid === 'string' ? s.cid : ''
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      if (removedCid && removedCid === selectedCID) setSelectedCID(null)
      void showAlert({ message: t('manage.removedNotice') })
    })
    return off
  }, [client, qc, selectedCID, t, showAlert])

  const sendDisabled = state !== 'connected'

  // 私聊对方名:从每个 direct 会话的 members 取「非自己」那个 uid,批量解析成显示名。
  const peerUids = Array.from(
    new Set(
      conversations
        .filter((c) => c.type === 'direct')
        .map((c) => c.members.find((u) => u !== currentUserUID))
        .filter((u): u is string => !!u)
    )
  )
  const { data: peerNames = {} } = useQuery({
    queryKey: ['im', 'peer-names', peerUids],
    queryFn: () => resolveImUsers(peerUids),
    enabled: peerUids.length > 0 && !!currentUserUID,
    staleTime: 60_000,
  })

  // 列表预览(P11)发送人名:群聊非系统消息的 last_sender_uid → 目录显示名。
  const lastSenderUids = Array.from(
    new Set(
      conversations
        .filter(
          (c) =>
            c.type === 'group' &&
            c.last_content_type !== 'system' &&
            !!c.last_sender_uid &&
            c.last_sender_uid !== currentUserUID
        )
        .map((c) => c.last_sender_uid as string)
    )
  )
  const { data: senderNames = {} } = useQuery({
    queryKey: ['im', 'sender-names', lastSenderUids],
    queryFn: () => resolveImUsers(lastSenderUids),
    enabled: lastSenderUids.length > 0,
    staleTime: 60_000,
  })

  // 群头像九宫格:解析每个群「前 9 名成员」的头像/名字,拼成微信/飞书式群头像。
  const groupMemberUids = Array.from(
    new Set(
      conversations
        .filter((c) => c.type === 'group')
        .flatMap((c) => c.members.slice(0, 9))
    )
  )
  const { data: groupMemberInfo = {} } = useQuery({
    queryKey: ['im', 'group-member-info', groupMemberUids],
    queryFn: () => resolveImUsers(groupMemberUids),
    enabled: groupMemberUids.length > 0,
    staleTime: 60_000,
  })

  // group → meta.name(无名兜底);direct → 对端显示名(兜底「私聊」)。
  const nameOf = (c: ConversationSummary): string => {
    if (c.type === 'group') {
      return c.name && c.name.trim() ? c.name : t('convName.groupFallback')
    }
    const peer = c.members.find((u) => u !== currentUserUID)
    return (peer && peerNames[peer]?.full_name) || t('convName.directFallback')
  }

  // direct 会话头像:对端上传的头像(presigned);群聊无单一头像 → 留空走色块。
  const avatarOf = (c: ConversationSummary): string | undefined => {
    if (c.type === 'group') return undefined
    const peer = c.members.find((u) => u !== currentUserUID)
    return (peer && peerNames[peer]?.avatar_url) || undefined
  }

  // 群头像成员瓦片:前 9 名成员的 {名字, 头像},喂给 GroupAvatar 拼九宫格。
  const membersOf = (c: ConversationSummary) => {
    if (c.type !== 'group') return undefined
    return c.members.slice(0, 9).map((uid) => ({
      name: groupMemberInfo[uid]?.full_name || '',
      src: groupMemberInfo[uid]?.avatar_url || undefined,
    }))
  }

  // 列表预览文案(P11):群聊「发送人: 正文」(系统消息无前缀);direct 仅正文。
  const previewOf = (
    c: ConversationSummary
  ): { text: string; ts: number } | null => {
    if (!c.last_message_ts) return null
    // 非文本消息用占位/解析文案(正文是 object_key / JSON,不该直接显示):
    // 图片 → [图片]、文件 → [文件]、表情 → [表情]、撤回 → 撤回了一条消息、
    // 引用 → 回复正文。
    const parseQuoteText = (raw?: string): string => {
      try {
        return (JSON.parse(raw ?? '')?.text as string) || ''
      } catch {
        return ''
      }
    }
    const ct = c.last_content_type
    const body =
      ct === 'image'
        ? t('preview.image')
        : ct === 'file'
          ? t('preview.file')
          : ct === 'voice'
            ? t('preview.voice')
            : ct === 'merged'
              ? t('preview.merged')
              : ct === 'reaction'
                ? t('preview.reaction')
                : ct === 'recall'
                  ? t('preview.recalled')
                  : ct === 'quote'
                    ? parseQuoteText(c.last_message)
                    : c.last_message ?? ''
    const ts = c.last_message_ts
    if (c.type !== 'group' || c.last_content_type === 'system') {
      return { text: body, ts }
    }
    const su = c.last_sender_uid
    const sender =
      su === currentUserUID
        ? t('group.you')
        : (su && senderNames[su]?.full_name) || ''
    return { text: sender ? `${sender}: ${body}` : body, ts }
  }

  const selectedConv = conversations.find((c) => c.cid === selectedCID) ?? null

  // 删除会话(direct 软隐藏)/ 退群(group;群主则服务端自动转让或解散)。
  const handleDelete = async (c: ConversationSummary) => {
    const confirmMsg =
      c.type === 'group'
        ? t('actions.leaveConfirm')
        : t('actions.deleteConfirm')
    if (!(await askConfirm({ message: confirmMsg, danger: true }))) return
    try {
      await client.leaveConversation(c.cid)
      if (selectedCID === c.cid) setSelectedCID(null)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 通讯录选人 -> backend 用 peer_user_id 服务端解析对方 IM uid -> jusi admin
  // create-or-get direct。客户端不再需要手输/知道原始 IM uid。
  const handleSelectMember = async (member: DirectoryMember) => {
    setPickerOpen(false)
    try {
      const result = await createDirectConversationByUserId(member.id)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setSelectedCID(result.cid)
    } catch (e) {
      void showAlert({
        message: t('list.newDirect.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 多选建群 -> backend 批量解析成员 IM uid + 生成群 cid + admin create_group。
  const handleCreateGroup = async (memberUserIds: string[], name: string) => {
    setGroupPickerOpen(false)
    try {
      const result = await createGroupConversation(memberUserIds, name)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setSelectedCID(result.cid)
    } catch (e) {
      void showAlert({
        message: t('group.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 从一对一会话「创建群组」:带上对方作为预选成员(对标飞书)。
  const handleCreateGroupFromDirect = async () => {
    if (!selectedConv) return
    const peerUid = selectedConv.members.find((u) => u !== currentUserUID)
    let seed: Array<{ id: string; label: string }> = []
    if (peerUid) {
      try {
        const resolved = await resolveImUsers([peerUid])
        const info = resolved[peerUid]
        if (info?.id) seed = [{ id: info.id, label: info.full_name || info.id }]
      } catch {
        // best-effort: open the picker without a preselected peer
      }
    }
    setGroupSeed(seed)
    setRightPanel(null)
    setGroupPickerOpen(true)
  }

  // 转发预览文案:图片→[图片]、文件→文件名(兜底[文件])、引用→可见正文、
  // 合并记录→[聊天记录]、其余取正文。
  const forwardSnippet = (m: Message): string => {
    if (m.content_type === 'image') return t('preview.image')
    if (m.content_type === 'file') {
      try {
        return (JSON.parse(m.body)?.name as string) || t('preview.file')
      } catch {
        return t('preview.file')
      }
    }
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

  // 把单条消息转发到目标会话:图片/文件/合并记录直接复用原 body(OSS key 可跨会话
  // resolve;合并 body 已自包含);引用只转可见正文为纯文本;其余原样发。
  const forwardOne = async (targetCid: string, m: Message) => {
    if (
      m.content_type === 'image' ||
      m.content_type === 'file' ||
      m.content_type === 'merged'
    ) {
      await client.sendText(targetCid, m.body, { contentType: m.content_type })
    } else if (m.content_type === 'quote') {
      let text = m.body
      try {
        text = (JSON.parse(m.body)?.text as string) || m.body
      } catch {
        // keep raw body
      }
      await client.sendText(targetCid, text)
    } else {
      await client.sendText(targetCid, m.body)
    }
  }

  // 发完统一收尾:刷新会话列表、跳到目标、提示。
  const afterForward = async (targetCid: string) => {
    await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    const target = conversations.find((c) => c.cid === targetCid)
    setSelectedCID(targetCid)
    void showAlert({
      message: t('forward.done', { name: target ? nameOf(target) : '' }),
    })
  }

  const handleForward = async (targetCid: string) => {
    const m = forwarding
    if (!m) return
    setForwarding(null)
    try {
      await forwardOne(targetCid, m)
      await afterForward(targetCid)
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 多选转发:逐条 → 按序重发每条;合并 → 打包成一条 content_type='merged'。
  const handleForwardMany = async (targetCid: string) => {
    const payload = forwardingMany
    if (!payload) return
    setForwardingMany(null)
    try {
      if (payload.mode === 'each') {
        for (const m of payload.messages) await forwardOne(targetCid, m)
      } else {
        await client.sendText(targetCid, JSON.stringify(payload.merged), {
          contentType: 'merged',
        })
      }
      await afterForward(targetCid)
    } catch (e) {
      void showAlert({
        message: t('actions.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  }

  // 会话 → 转发选择器条目(复用 nameOf / avatarOf / membersOf)。
  const forwardConvs: ForwardConv[] = conversations.map((c) => ({
    cid: c.cid,
    name: nameOf(c),
    avatarUrl: avatarOf(c),
    members: membersOf(c),
    isGroup: c.type === 'group',
  }))

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '600px',
      })}
    >
      <ConnectionStatusBar state={state} />
      <div
        className={css({
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        })}
      >
        <ResizablePanel
          storageKey="we-meet:im-list-width"
          defaultWidth={280}
          min={240}
          max={460}
        >
        <aside
          className={css({
            width: '100%',
            height: '100%',
            borderRight: '1px solid token(colors.greyscale.200)',
            overflowY: 'auto',
            backgroundColor: 'greyscale.50',
          })}
        >
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingX: '1rem',
              paddingY: '0.75rem',
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
              {t('list.title')}
            </h2>
            <div className={css({ display: 'flex', gap: '0.375rem' })}>
              <button
                type="button"
                onClick={() => {
                  setGroupSeed([])
                  setGroupPickerOpen(true)
                }}
                title={t('group.button')}
                aria-label={t('group.button')}
                data-testid="im-new-group"
                className={css({
                  border: '1px solid token(colors.greyscale.300)',
                  borderRadius: '999px',
                  backgroundColor: 'greyscale.000',
                  width: '1.75rem',
                  height: '1.75rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.9rem',
                  lineHeight: 1,
                  cursor: 'pointer',
                  color: 'greyscale.700',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                👥
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                title={t('list.newDirect.button')}
                aria-label={t('list.newDirect.button')}
                data-testid="im-new-direct"
                className={css({
                  border: '1px solid token(colors.greyscale.300)',
                  borderRadius: '999px',
                  backgroundColor: 'greyscale.000',
                  width: '1.75rem',
                  height: '1.75rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.125rem',
                  lineHeight: 1,
                  cursor: 'pointer',
                  color: 'greyscale.700',
                  _hover: { backgroundColor: 'greyscale.100' },
                })}
              >
                +
              </button>
            </div>
          </div>
          <ConversationList
            conversations={conversations}
            selectedCID={selectedCID}
            onSelect={setSelectedCID}
            loading={convLoading}
            nameOf={nameOf}
            avatarOf={avatarOf}
            membersOf={membersOf}
            onDelete={handleDelete}
            mentionedCids={mentionedCids}
            previewOf={previewOf}
          />
        </aside>
        </ResizablePanel>
        <main
          className={css({
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          })}
        >
          {selectedConv ? (
            <ChatPane
              client={client}
              conversation={selectedConv}
              title={nameOf(selectedConv)}
              currentUserUID={currentUserUID}
              sendDisabled={sendDisabled}
              onOpenInfo={
                selectedConv.type === 'group'
                  ? () =>
                      setRightPanel((p) => (p === 'members' ? null : 'members'))
                  : undefined
              }
              onOpenSettings={() =>
                setRightPanel((p) => (p === 'settings' ? null : 'settings'))
              }
              onAddMembers={
                selectedConv.type === 'group'
                  ? () => setAddOpen(true)
                  : undefined
              }
              onForward={(m) => setForwarding(m)}
              onForwardMany={(p) => setForwardingMany(p)}
              infoPanel={
                rightPanel === 'members' &&
                selectedConv.type === 'group' ? (
                  <GroupMembersPanel
                    client={client}
                    conversation={selectedConv}
                    currentUserUID={currentUserUID}
                    onClose={() => setRightPanel(null)}
                  />
                ) : rightPanel === 'settings' ? (
                  selectedConv.type === 'group' ? (
                    <GroupSettingsPanel
                      client={client}
                      conversation={selectedConv}
                      currentUserUID={currentUserUID}
                      onLeft={() => {
                        setRightPanel(null)
                        setSelectedCID(null)
                      }}
                      onClose={() => setRightPanel(null)}
                    />
                  ) : (
                    <DirectSettingsPanel
                      client={client}
                      conversation={selectedConv}
                      peerName={nameOf(selectedConv)}
                      peerAvatarUrl={avatarOf(selectedConv)}
                      onCreateGroup={() => void handleCreateGroupFromDirect()}
                      onClose={() => setRightPanel(null)}
                    />
                  )
                ) : null
              }
            />
          ) : (
            <div
              className={css({
                padding: '2rem',
                color: 'greyscale.500',
                textAlign: 'center',
                marginTop: '2rem',
              })}
            >
              {selectedCID ? t('chat.loading') : t('chat.pickPrompt')}
            </div>
          )}
        </main>
      </div>
      {pickerOpen && (
        <ContactPicker
          onSelect={handleSelectMember}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {groupPickerOpen && (
        <GroupPicker
          onCreate={handleCreateGroup}
          onClose={() => setGroupPickerOpen(false)}
          initialMembers={groupSeed}
        />
      )}
      {addOpen && selectedConv && selectedConv.type === 'group' && (
        <AddMemberDialog
          client={client}
          cid={selectedConv.cid}
          onClose={() => setAddOpen(false)}
        />
      )}
      {forwarding && (
        <ForwardDialog
          conversations={forwardConvs}
          previewText={forwardSnippet(forwarding)}
          onConfirm={(cid) => void handleForward(cid)}
          onClose={() => setForwarding(null)}
        />
      )}
      {forwardingMany && (
        <ForwardDialog
          conversations={forwardConvs}
          previewText={
            forwardingMany.mode === 'merged'
              ? forwardingMany.merged.title
              : t('select.count', { count: forwardingMany.messages.length })
          }
          onConfirm={(cid) => void handleForwardMany(cid)}
          onClose={() => setForwardingMany(null)}
        />
      )}
    </div>
  )
}
