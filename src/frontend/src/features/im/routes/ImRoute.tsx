import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'

import { ContactPicker } from '@/features/contacts'
import type { DirectoryMember } from '@/features/contacts'
import type { ConversationSummary } from '@jusi/light-im-sdk'

import { createDirectConversationByUserId } from '../api/createDirectConversation'
import { createGroupConversation } from '../api/createGroupConversation'
import { resolveImUsers } from '../api/resolveImUsers'
import { fetchImToken } from '../api/fetchImToken'
import { ChatPane } from './ChatPane'
import { AddMemberDialog } from '../components/AddMemberDialog'
import { ConnectionStatusBar } from '../components/ConnectionStatusBar'
import { ConversationList } from '../components/ConversationList'
import { GroupInfoPanel } from '../components/GroupInfoPanel'
import { GroupPicker } from '../components/GroupPicker'
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
export const ImRoute = () => {
  const { t } = useTranslation('im')
  const { user, isLoggedIn } = useUser()

  if (!isLoggedIn || !user) {
    return (
      <div className={css({ padding: '2rem', color: 'greyscale.700' })}>
        {t('auth.required')}
      </div>
    )
  }

  return <ImAuthenticated />
}

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
  const { data: conversations = [], isLoading: convLoading } = useConversations(
    client,
    currentUserUID,
  )
  // 从通讯录跳来时 URL 带 ?cid=<会话>,直接预选并打开该会话。
  const [searchParams] = useSearchParams()
  const initialCID = searchParams.get('cid')
  const [selectedCID, setSelectedCID] = useState<string | null>(initialCID)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // cids with an unread message that @-mentioned me (red "@" marker in the list).
  const [mentionedCids, setMentionedCids] = useState<Set<string>>(new Set())
  const qc = useQueryClient()

  // 带 cid 进来时刷新会话列表,让新建/已存在的会话出现在左栏(ChatPane 本身已按 cid 渲染)。
  useEffect(() => {
    if (initialCID) {
      setSelectedCID(initialCID)
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    }
  }, [initialCID, qc])

  // 被 @ 提醒:收到他人消息且 @我自己 或 @所有人、且不在当前会话 → 列表标红「@」。
  const selfName = user?.full_name || ''
  const everyone = t('mention.everyone')
  useEffect(() => {
    const off = client.onMessage((m) => {
      if (m.sender_uid === currentUserUID || m.cid === selectedCID) return
      const body = m.body || ''
      const mentionsMe =
        (!!selfName && body.includes(`@${selfName}`)) || body.includes(`@${everyone}`)
      if (mentionsMe) {
        setMentionedCids((prev) => {
          if (prev.has(m.cid)) return prev
          const next = new Set(prev)
          next.add(m.cid)
          return next
        })
      }
    })
    return off
  }, [client, currentUserUID, selectedCID, selfName, everyone])

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
      window.alert(t('manage.removedNotice'))
    })
    return off
  }, [client, qc, selectedCID, t])

  const sendDisabled = state !== 'connected'

  // 私聊对方名:从每个 direct 会话的 members 取「非自己」那个 uid,批量解析成显示名。
  const peerUids = Array.from(
    new Set(
      conversations
        .filter((c) => c.type === 'direct')
        .map((c) => c.members.find((u) => u !== currentUserUID))
        .filter((u): u is string => !!u),
    ),
  )
  const { data: peerNames = {} } = useQuery({
    queryKey: ['im', 'peer-names', peerUids],
    queryFn: () => resolveImUsers(peerUids),
    enabled: peerUids.length > 0 && !!currentUserUID,
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

  const selectedConv = conversations.find((c) => c.cid === selectedCID) ?? null

  // 删除会话(direct 软隐藏)/ 退群(group;群主则服务端自动转让或解散)。
  const handleDelete = async (c: ConversationSummary) => {
    const confirmMsg =
      c.type === 'group' ? t('actions.leaveConfirm') : t('actions.deleteConfirm')
    if (!window.confirm(confirmMsg)) return
    try {
      await client.leaveConversation(c.cid)
      if (selectedCID === c.cid) setSelectedCID(null)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      window.alert(
        t('actions.error', { message: e instanceof Error ? e.message : String(e) }),
      )
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
      window.alert(
        t('list.newDirect.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      )
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
      window.alert(
        t('group.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      )
    }
  }

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
        <aside
          className={css({
            width: '280px',
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
                onClick={() => setGroupPickerOpen(true)}
                title={t('group.button')}
                aria-label={t('group.button')}
                data-testid="im-new-group"
                className={css({
                  border: '1px solid token(colors.greyscale.300)',
                  borderRadius: '999px',
                  backgroundColor: 'white',
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
                  backgroundColor: 'white',
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
            onDelete={handleDelete}
            mentionedCids={mentionedCids}
          />
        </aside>
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
                  ? () => setInfoOpen((v) => !v)
                  : undefined
              }
              onAddMembers={
                selectedConv.type === 'group' ? () => setAddOpen(true) : undefined
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
        {infoOpen && selectedConv && selectedConv.type === 'group' && (
          <GroupInfoPanel
            client={client}
            conversation={selectedConv}
            currentUserUID={currentUserUID}
            onAddMembers={() => setAddOpen(true)}
            onLeft={() => {
              setInfoOpen(false)
              setSelectedCID(null)
            }}
            onClose={() => setInfoOpen(false)}
          />
        )}
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
        />
      )}
      {addOpen && selectedConv && selectedConv.type === 'group' && (
        <AddMemberDialog
          client={client}
          cid={selectedConv.cid}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  )
}
