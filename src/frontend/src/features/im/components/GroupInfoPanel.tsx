import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'
import { RiCalendarScheduleLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'

import { announceLeave } from '../api/announceLeave'
import { listGroupBots } from '../api/groupBots'
import { updateGroupMeta } from '../api/updateGroupMeta'
import { resolveImUsers } from '../api/resolveImUsers'
import { useGroupRoster } from '../hooks/useGroupRoster'
import { GroupAvatar } from './GroupAvatar'
import { GroupMembersPage } from './GroupMembersPage'
import { PanelFrame } from './PanelFrame'
import { SettingRow, SwitchRow } from './SettingRows'
import { GroupBotsPage } from './bots/GroupBotsPage'
import { GroupBotDetailPage } from './bots/GroupBotDetailPage'
import { editBtn, sectionLabel } from './panelStyles'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Opens the add-members dialog (＋ next to the member count). */
  onAddMembers: () => void
  /** Called after the caller leaves the group (clears the open conversation). */
  onLeft: () => void
  /** Opens the existing group members' calendar panel. */
  onOpenCalendar: () => void
  onClose: () => void
}

/** Read the group description out of the conversation's free-form meta blob. */
const readDescription = (meta: unknown): string => {
  if (meta && typeof meta === 'object' && 'description' in meta) {
    const d = (meta as Record<string, unknown>).description
    if (typeof d === 'string') return d
  }
  return ''
}

/** Root page, member list, bot list, or one bot's detail. */
type PanelView =
  | { name: 'root' }
  | { name: 'members' }
  | { name: 'bots' }
  | { name: 'bot'; botId: string }

/**
 * 群聊信息 — the single group panel, merging what used to be the separate
 * 群成员 (roster) and 群设置 (attributes) columns into one, mirroring the
 * Android `GroupInfoScreen`. Top-to-bottom: group avatar + name (owner
 * rename), 群描述 (owner edit), my group nickname, the private 置顶 / 免打扰 /
 * @所有人不提示 toggles (P10), the member roster (count + add + owner badge +
 * transfer/kick), 清空聊天记录, and leave. Rendered as a fixed column below
 * the chat header.
 */
export const GroupInfoPanel = ({
  client,
  conversation,
  currentUserUID,
  onAddMembers,
  onLeft,
  onOpenCalendar,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const qc = useQueryClient()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const description = readDescription(conversation.meta)
  // Per-member settings come off the summary (P10).
  const pinned = !!conversation.pinned
  const muted = !!conversation.muted
  const muteAtAll = !!conversation.mute_at_all

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversation.name || '')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(description)
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const nickRef = useRef<HTMLInputElement>(null)
  const displayName = conversation.name || t('convName.groupFallback')

  // Sub-pages are local state, matching how the rest of the app switches
  // panels (ImRoute's rightPanel, ContactsRoute's view). `/im` is a flat route
  // with no children, so a URL-driven version is not available anyway.
  const [view, setView] = useState<PanelView>({ name: 'root' })
  const back = () =>
    setView(view.name === 'bot' ? { name: 'bots' } : { name: 'root' })

  // Switching conversations swaps props without remounting, so without this
  // you would open another group and still be looking at the previous one's
  // bot list.
  useEffect(() => setView({ name: 'root' }), [cid])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc closes the panel from the root page and steps back from a sub-page.
      if (view.name === 'root') onClose()
      else setView(view.name === 'bot' ? { name: 'bots' } : { name: 'root' })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, view])

  useEffect(() => {
    if (editingName) nameRef.current?.focus()
  }, [editingName])
  useEffect(() => {
    if (editingDesc) descRef.current?.focus()
  }, [editingDesc])
  useEffect(() => {
    if (editingNick) nickRef.current?.focus()
  }, [editingNick])

  // 花名册整体搬去了成员二级页,但 root 仍要挂这个 hook ——「我的群昵称」
  // 那一行没有第二个来源:`ConversationSummary` 里不含 caller 自己的 nickname。
  // 两处同时挂是安全的(同 queryKey 去重),理由写在 useGroupRoster 的注释里。
  const { myNickname } = useGroupRoster(client, cid, currentUserUID)

  // 群头像九宫格:解析前 9 名成员的头像/名字拼贴(同会话列表的群头像)。
  const tileUids = conversation.members.slice(0, 9)
  const { data: tileInfo = {} } = useQuery({
    queryKey: ['im', 'group-member-info', tileUids],
    queryFn: () => resolveImUsers(tileUids),
    enabled: tileUids.length > 0,
    staleTime: 60_000,
  })
  const avatarTiles = tileUids.map((uid) => ({
    name: tileInfo[uid]?.full_name || '',
    src: tileInfo[uid]?.avatar_url || undefined,
  }))

  // 机器人计数(对标飞书:入口右侧带数字)。同 queryKey 与 GroupBotsPage 共享
  // 缓存 —— 进二级页不会再请求一次,页内增删后的 invalidate 也会更新这里。
  const { data: bots } = useQuery({
    queryKey: ['im', 'bots', cid],
    queryFn: () => listGroupBots(cid),
    staleTime: 30_000,
    retry: false,
  })

  const onError = (e: unknown) =>
    void showAlert({
      message: t('manage.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

  const saveName = async () => {
    const next = nameDraft.trim()
    if (!next || next === conversation.name) {
      setEditingName(false)
      return
    }
    setBusy(true)
    try {
      // Send full meta (preserve description) — jusi replaces meta wholesale.
      await updateGroupMeta(cid, { name: next, description, kind: 'rename' })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setEditingName(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const saveDescription = async () => {
    const next = descDraft.trim()
    if (next === description) {
      setEditingDesc(false)
      return
    }
    setBusy(true)
    try {
      await updateGroupMeta(cid, {
        name: conversation.name || '',
        description: next,
        kind: 'description',
      })
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setEditingDesc(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const saveNickname = async () => {
    const next = nickDraft.trim()
    if (next === myNickname) {
      setEditingNick(false)
      return
    }
    setBusy(true)
    try {
      await client.setConversationSettings(cid, { nickname: next })
      // Roster carries nickname (drives my row + how others/messages render me).
      await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      setEditingNick(false)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  // pinned / muted / mute_at_all are private toggles surfaced on the summary;
  // flip then refresh the list (reorders pinned + re-reads the flags).
  const toggle = async (patch: {
    pinned?: boolean
    muted?: boolean
    mute_at_all?: boolean
  }) => {
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

  const leave = async () => {
    if (
      !(await askConfirm({
        message: t('manage.leaveConfirm'),
        confirmLabel: t('manage.leave'),
        danger: true,
      }))
    )
      return
    setBusy(true)
    try {
      await announceLeave(cid).catch(() => {})
      await client.leaveConversation(cid)
      qc.removeQueries({ queryKey: ['im', 'members', cid] })
      onLeft()
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    } catch (e) {
      onError(e)
      setBusy(false)
    }
  }

  if (view.name === 'members')
    return (
      <PanelFrame
        key="members"
        title={t('manage.membersTitle')}
        onBack={back}
        onClose={onClose}
      >
        <GroupMembersPage
          client={client}
          conversation={conversation}
          currentUserUID={currentUserUID}
          onAddMembers={onAddMembers}
        />
      </PanelFrame>
    )

  if (view.name === 'bots')
    return (
      <PanelFrame
        key="bots"
        title={t('bots.title')}
        onBack={back}
        onClose={onClose}
      >
        <GroupBotsPage
          cid={cid}
          isOwner={isOwner}
          onOpenBot={(botId) => setView({ name: 'bot', botId })}
        />
      </PanelFrame>
    )

  if (view.name === 'bot')
    return (
      <PanelFrame
        key={view.botId}
        title={t('bots.title')}
        onBack={back}
        onClose={onClose}
      >
        <GroupBotDetailPage cid={cid} botId={view.botId} onRemoved={back} />
      </PanelFrame>
    )

  return (
    <PanelFrame
      key="root"
      title={t('manage.settings')}
      onClose={onClose}
      footer={
        <button
          type="button"
          disabled={busy}
          onClick={leave}
          data-testid="group-leave"
          className={css({
            width: '100%',
            paddingY: '0.5rem',
            border: '1px solid token(colors.greyscale.300)',
            borderRadius: '0.5rem',
            backgroundColor: 'greyscale.000',
            color: 'error.500',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.50' },
          })}
        >
          {t('manage.leave')}
        </button>
      }
    >
      {/* Group identity: avatar + name (owner can rename inline) */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
      >
        <GroupAvatar members={avatarTiles} size="2.75rem" />
        {editingName ? (
          <div className={css({ display: 'flex', flex: 1, gap: '0.5rem' })}>
            <input
              ref={nameRef}
              type="text"
              value={nameDraft}
              maxLength={60}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={t('manage.renamePlaceholder')}
              data-testid="group-rename-input"
              className={inputCls}
            />
            <Button
              variant="primary"
              size="dense"
              isDisabled={busy}
              onPress={saveName}
              data-testid="group-rename-save"
            >
              {t('manage.save')}
            </Button>
          </div>
        ) : (
          <div
            className={css({
              display: 'flex',
              flex: 1,
              minWidth: 0,
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
                fontWeight: 'medium',
                color: 'greyscale.900',
              })}
            >
              {displayName}
            </span>
            {isOwner && (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(conversation.name || '')
                  setEditingName(true)
                }}
                title={t('manage.rename')}
                aria-label={t('manage.rename')}
                data-testid="group-rename"
                className={editBtn}
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      {/* Group announcement (stored in the shared description field). */}
      <div className={sectionCls}>
        <div className={sectionHead}>
          <span className={sectionLabel}>{t('manage.description')}</span>
          {isOwner && !editingDesc && (
            <button
              type="button"
              onClick={() => {
                setDescDraft(description)
                setEditingDesc(true)
              }}
              aria-label={t('manage.description')}
              data-testid="group-desc-edit"
              className={editBtn}
            >
              ✎
            </button>
          )}
        </div>
        {editingDesc ? (
          <div
            className={css({
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            })}
          >
            <textarea
              ref={descRef}
              value={descDraft}
              maxLength={200}
              rows={3}
              onChange={(e) => setDescDraft(e.target.value)}
              placeholder={t('manage.descriptionPlaceholder')}
              data-testid="group-desc-input"
              className={css({
                width: '100%',
                resize: 'none',
                paddingX: '0.625rem',
                paddingY: '0.375rem',
                border: '1px solid token(colors.greyscale.300)',
                borderRadius: '0.5rem',
                fontSize: '0.875rem',
                outline: 'none',
                _focus: { borderColor: 'primary.500' },
              })}
            />
            <div className={editActions}>
              <Button
                variant="secondary"
                size="dense"
                onPress={() => setEditingDesc(false)}
              >
                {t('manage.cancel')}
              </Button>
              <Button
                variant="primary"
                size="dense"
                isDisabled={busy}
                onPress={saveDescription}
                data-testid="group-desc-save"
              >
                {t('manage.save')}
              </Button>
            </div>
          </div>
        ) : (
          <p
            className={css({
              margin: 0,
              fontSize: '0.875rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: description ? 'greyscale.800' : 'greyscale.400',
            })}
          >
            {description || t('manage.descriptionEmpty')}
          </p>
        )}
      </div>

      {/* My group nickname (every member edits their own) */}
      <div className={sectionCls}>
        <div className={sectionHead}>
          <span className={sectionLabel}>{t('manage.nickname')}</span>
          {!editingNick && (
            <button
              type="button"
              onClick={() => {
                setNickDraft(myNickname)
                setEditingNick(true)
              }}
              aria-label={t('manage.nickname')}
              data-testid="group-nick-edit"
              className={editBtn}
            >
              ✎
            </button>
          )}
        </div>
        {editingNick ? (
          <div className={css({ display: 'flex', gap: '0.5rem' })}>
            <input
              ref={nickRef}
              type="text"
              value={nickDraft}
              maxLength={60}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder={t('manage.nicknamePlaceholder')}
              data-testid="group-nick-input"
              className={inputCls}
            />
            <Button
              variant="primary"
              size="dense"
              isDisabled={busy}
              onPress={saveNickname}
              data-testid="group-nick-save"
            >
              {t('manage.save')}
            </Button>
          </div>
        ) : (
          <p
            className={css({
              margin: 0,
              fontSize: '0.875rem',
              color: myNickname ? 'greyscale.800' : 'greyscale.400',
            })}
          >
            {myNickname || t('manage.nicknameEmpty')}
          </p>
        )}
      </div>

      {/* Apps: keep the desktop entry in the same information hierarchy
            as Android while opening the existing right-side calendar panel. */}
      <section
        className={css({
          padding: '0.875rem 1rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
        })}
      >
        <div className={css({ marginBottom: '0.75rem' })}>
          <span className={sectionLabel}>{t('manage.apps')}</span>
        </div>
        <button
          type="button"
          onClick={onOpenCalendar}
          data-testid="group-calendar-entry"
          aria-label={t('calendar.groupOpen')}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.375rem',
            width: '5rem',
            padding: '0.625rem 0.375rem',
            border: 'none',
            borderRadius: '0.625rem',
            backgroundColor: 'transparent',
            color: 'greyscale.900',
            fontSize: '0.8125rem',
            cursor: 'pointer',
            _hover: { backgroundColor: 'greyscale.50' },
          })}
        >
          <span
            className={css({
              display: 'grid',
              placeItems: 'center',
              width: '2.75rem',
              height: '2.75rem',
              borderRadius: '0.625rem',
              backgroundColor: 'primary.100',
              color: 'primary.600',
            })}
          >
            <RiCalendarScheduleLine size={24} />
          </span>
          <span className={css({ whiteSpace: 'nowrap' })}>
            {t('calendar.groupOpen')}
          </span>
        </button>
      </section>

      {/* 群成员 —— 放在机器人**上面**:人优先于工具。计数用
            `conversation.members` 而不是花名册,省掉 root 对 roster 长度的
            依赖(jusi P23 已把机器人排除在 members 之外,与 listMembers 同值)。 */}
      <SettingRow
        label={t('manage.members')}
        value={String(conversation.members.length)}
        onClick={() => setView({ name: 'members' })}
        testid="group-members-entry"
      />

      {/* 群机器人 —— a management entry (add / configure / read credentials),
            so it opens a sub-page rather than sitting inline the way the roster
            does (对标飞书). */}
      <SettingRow
        label={t('bots.entry')}
        // 没拿到之前不显示 —— 先写 0 再跳成 2,看着像刚被人加了一个。
        value={bots ? String(bots.length) : undefined}
        onClick={() => setView({ name: 'bots' })}
        testid="group-bots-entry"
      />

      {/* Private notification settings (P10). */}
      <SwitchRow
        label={t('manage.pin')}
        checked={pinned}
        onChange={() => toggle({ pinned: !pinned })}
        disabled={busy}
        testid="group-pin-toggle"
      />
      <SwitchRow
        label={t('manage.mute')}
        checked={muted}
        onChange={() => toggle({ muted: !muted })}
        disabled={busy}
        testid="group-mute-toggle"
      />
      <SwitchRow
        label={t('manage.muteAtAll')}
        checked={muteAtAll}
        onChange={() => toggle({ mute_at_all: !muteAtAll })}
        disabled={busy}
        testid="group-mute-all-toggle"
      />

      {/* Clear history (per-member) */}
      <button
        type="button"
        disabled={busy}
        onClick={clearHistory}
        data-testid="group-clear"
        className={css({
          width: '100%',
          textAlign: 'left',
          padding: '0.625rem 1rem',
          border: 'none',
          borderTop: '1px solid token(colors.greyscale.100)',
          backgroundColor: 'greyscale.000',
          color: 'greyscale.900',
          fontSize: '0.875rem',
          cursor: 'pointer',
          _hover: { backgroundColor: 'greyscale.50' },
        })}
      >
        {t('manage.clear')}
      </button>
    </PanelFrame>
  )
}

const inputCls = css({
  flex: 1,
  minWidth: 0,
  paddingX: '0.625rem',
  paddingY: '0.375rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

const sectionCls = css({
  padding: '0.875rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})

const sectionHead = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.375rem',
})

const editActions = css({
  display: 'flex',
  gap: '0.5rem',
  justifyContent: 'flex-end',
})
