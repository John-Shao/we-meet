import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { Switch } from '@/primitives/Switch'
import { useConfirm } from '@/components/ConfirmProvider'

import { announceLeave } from '../api/announceLeave'
import { updateGroupMeta } from '../api/updateGroupMeta'
import { removeMember } from '../api/removeMember'
import { resolveImUsers } from '../api/resolveImUsers'
import { GroupAvatar } from './GroupAvatar'
import { Avatar } from './Avatar'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Opens the add-members dialog (＋ next to the member count). */
  onAddMembers: () => void
  /** Called after the caller leaves the group (clears the open conversation). */
  onLeft: () => void
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (editingName) nameRef.current?.focus()
  }, [editingName])
  useEffect(() => {
    if (editingDesc) descRef.current?.focus()
  }, [editingDesc])
  useEffect(() => {
    if (editingNick) nickRef.current?.focus()
  }, [editingNick])

  // The roster is its own REST query; a conv lifecycle event for this group
  // (someone joined / left / was removed) only refreshes the conversation list,
  // not this query — so without invalidating here the open panel stays stale
  // until reopened. Refetch the roster whenever this conversation changes.
  useEffect(() => {
    const off = client.onConversation((ev) => {
      if (ev.cid === cid) {
        void qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
      }
    })
    return off
  }, [client, cid, qc])

  const { data: roster = [], isLoading } = useQuery({
    queryKey: ['im', 'members', cid],
    queryFn: () => client.listMembers(cid),
    staleTime: 30_000,
    // Never retry: a 403 (you left / were removed) won't succeed on retry, and
    // the default 3× backoff would freeze the UI ~5s after leaving the group.
    retry: false,
  })
  const rosterUids = roster.map((m) => m.uid)
  const { data: names = {} } = useQuery({
    queryKey: ['im', 'member-names', rosterUids],
    queryFn: () => resolveImUsers(rosterUids),
    enabled: rosterUids.length > 0,
    staleTime: 60_000,
  })
  // P10: a member's group nickname overrides their org-directory name.
  const nameOf = (uid: string) =>
    roster.find((m) => m.uid === uid)?.nickname || names[uid]?.full_name || uid
  const myNickname =
    roster.find((m) => m.uid === currentUserUID)?.nickname ?? ''

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

  const onError = (e: unknown) =>
    void showAlert({
      message: t('manage.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['im', 'members', cid] })
    await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
  }

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

  const kick = async (uid: string) => {
    const userId = names[uid]?.id
    if (!userId) return
    if (
      !(await askConfirm({
        message: t('manage.removeConfirm', { name: nameOf(uid) }),
        confirmLabel: t('manage.remove'),
        danger: true,
      }))
    )
      return
    setBusy(true)
    try {
      await removeMember(cid, userId)
      await refresh()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const transfer = async (uid: string) => {
    if (
      !(await askConfirm({
        message: t('manage.transferConfirm', { name: nameOf(uid) }),
        confirmLabel: t('manage.transfer'),
      }))
    )
      return
    setBusy(true)
    try {
      await client.transferOwner(cid, uid)
      await refresh()
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

  const toggleRow = (
    label: string,
    checked: boolean,
    onChange: () => void,
    testid: string
  ): ReactNode => (
    <div
      className={css({
        display: 'flex',
        alignItems: 'center',
        padding: '0.625rem 1rem',
        borderBottom: '1px solid token(colors.greyscale.100)',
      })}
    >
      {/* 布尔设置用开关(对标飞书):整行可点,标签作 Switch 子节点。 */}
      <Switch
        isSelected={checked}
        isDisabled={busy}
        onChange={onChange}
        data-testid={testid}
        className={css({
          width: '100%',
          flexDirection: 'row-reverse',
          justifyContent: 'space-between',
        })}
      >
        <span className={css({ fontSize: '0.875rem', color: 'greyscale.900' })}>
          {label}
        </span>
      </Switch>
    </div>
  )

  return (
    <aside
      aria-label={t('manage.info')}
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        // P8-UX:宽度由外层 ResizablePanel(side=right)拖拽控制。
        width: '100%',
        height: '100%',
        backgroundColor: 'greyscale.000',
        borderLeft: '1px solid token(colors.greyscale.200)',
        overflow: 'hidden',
        animation: 'fade token(durations.normal) ease-out',
      })}
    >
      {/* Header */}
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
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
          {t('manage.info')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('manage.cancel')}
          className={css({
            border: 'none',
            background: 'transparent',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
            color: 'greyscale.600',
          })}
        >
          ×
        </button>
      </div>

      <div className={css({ flex: 1, overflowY: 'auto' })}>
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

        {/* Group description (owner edits; everyone reads) */}
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

        {/* Private toggles (P10) */}
        {toggleRow(
          t('manage.pin'),
          pinned,
          () => toggle({ pinned: !pinned }),
          'group-pin-toggle'
        )}
        {toggleRow(
          t('manage.mute'),
          muted,
          () => toggle({ muted: !muted }),
          'group-mute-toggle'
        )}
        {toggleRow(
          t('manage.muteAtAll'),
          muteAtAll,
          () => toggle({ mute_at_all: !muteAtAll }),
          'group-mute-all-toggle'
        )}

        {/* Members: count + add, then the roster (owner badge + transfer/kick) */}
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingX: '1rem',
            paddingTop: '0.875rem',
            paddingBottom: '0.375rem',
          })}
        >
          <span className={sectionLabel}>
            {t('manage.members')} ({roster.length})
          </span>
          <button
            type="button"
            onClick={onAddMembers}
            title={t('manage.addMembers')}
            aria-label={t('manage.addMembers')}
            data-testid="group-add-members"
            className={editBtn}
          >
            ＋
          </button>
        </div>
        <ul
          className={css({
            listStyle: 'none',
            margin: 0,
            padding: '0 0 0.5rem',
          })}
        >
          {isLoading ? (
            <li
              className={css({ padding: '0.5rem 1rem', color: 'greyscale.500' })}
            >
              {t('group.loading')}
            </li>
          ) : (
            roster.map((m) => {
              const label = nameOf(m.uid)
              const isSelf = m.uid === currentUserUID
              // Drive the badge off owner_uid (authoritative) rather than the
              // roster role, which can lag a transfer until the row re-syncs.
              const isRowOwner = m.uid === conversation.owner_uid
              const canActOnRow = isOwner && !isSelf && !isRowOwner
              return (
                <li
                  key={m.uid}
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.625rem',
                    paddingX: '1rem',
                    paddingY: '0.375rem',
                    _hover: { backgroundColor: 'greyscale.50' },
                  })}
                >
                  <Avatar
                    name={label}
                    src={names[m.uid]?.avatar_url}
                    size="2rem"
                  />
                  <span
                    className={css({
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'greyscale.900',
                    })}
                  >
                    {label}
                  </span>
                  {isRowOwner && (
                    <span
                      className={css({
                        flexShrink: 0,
                        fontSize: '0.6875rem',
                        borderRadius: '0.25rem',
                        paddingX: '0.25rem',
                        color: 'brand.600',
                        backgroundColor: 'brand.50',
                        border: '1px solid token(colors.brand.200)',
                      })}
                    >
                      {t('manage.owner')}
                    </span>
                  )}
                  {canActOnRow && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => transfer(m.uid)}
                        title={t('manage.transfer')}
                        aria-label={t('manage.transfer')}
                        data-testid={`member-transfer-${m.uid}`}
                        className={css({
                          flexShrink: 0,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: 'greyscale.500',
                          fontSize: '0.875rem',
                          _hover: { color: 'primary.500' },
                        })}
                      >
                        ♛
                      </button>
                      <button
                        type="button"
                        disabled={busy || !names[m.uid]?.id}
                        onClick={() => kick(m.uid)}
                        title={t('manage.remove')}
                        aria-label={t('manage.remove')}
                        data-testid={`member-kick-${m.uid}`}
                        className={css({
                          flexShrink: 0,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: 'greyscale.500',
                          fontSize: '0.875rem',
                          _hover: { color: 'error.500' },
                        })}
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              )
            })
          )}
        </ul>

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
      </div>

      {/* Footer: leave (every member) */}
      <div
        className={css({
          padding: '0.75rem 1rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
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
      </div>
    </aside>
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

const editBtn = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  fontSize: '0.875rem',
  _hover: { color: 'primary.500' },
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

const sectionLabel = css({ fontSize: '0.8125rem', color: 'greyscale.600' })

const editActions = css({
  display: 'flex',
  gap: '0.5rem',
  justifyContent: 'flex-end',
})
