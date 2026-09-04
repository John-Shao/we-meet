import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { MemberAvatar, useDirectoryMemberSearch } from '@/features/contacts'
import {
  Button,
  Input,
  InteractiveListRow,
  SegmentedControl,
  SelectableListRow,
} from '@/primitives'

import { createDirectConversationByUserId } from '../api/createDirectConversation'

import { GroupAvatar, type GroupAvatarMember } from './GroupAvatar'

/** A forward target as seen by the picker — resolved upstream in ImRoute. */
export interface ForwardConv {
  cid: string
  name: string
  /** direct peer avatar (presigned); undefined for groups. */
  avatarUrl?: string
  /** group member tiles for the mosaic avatar; undefined for direct. */
  members?: GroupAvatarMember[]
  isGroup: boolean
  /** 单聊对端的 we-meet user id —— 用来和通讯录搜索结果去重(已经有会话的人
   * 不该在「通讯录」分组里再出现一次)。缺失时该会话不参与去重。 */
  peerUserId?: string
}

interface Props {
  conversations: ForwardConv[]
  /** 会话还在拉取中 —— 区分「加载中」与「真的一个会话都没有」。分享类入口
   * (日程/会议/云文档)是点开才挂载的,列表必然冷启动,不区分就会先闪一下
   * 「没有可转发的会话」。 */
  isLoading?: boolean
  /** One-line preview of the message being forwarded (shown at the top). */
  previewText: string
  /** Confirm forwarding to one or more target conversations (飞书式多选)。 */
  onConfirm: (cids: string[]) => void
  /** Open the create-group flow, then forward into the new group (飞书式)。
   * Omitted (e.g. picker invoked outside the IM route) → row hidden. */
  onCreateGroupForward?: () => void
  /** Optional business-specific second tab (for example a copy-link view). */
  secondaryTab?: { label: string; content: ReactNode }
  primaryTabLabel?: string
  title?: string
  onClose: () => void
}

/**
 * 消息转发选择器(P7-e):挑一个或多个目标,把选中的消息重发过去。
 * 勾选 + 发送两步,避免误点直接外发。
 *
 * 搜索同时覆盖**已有会话**和**通讯录**(对标飞书):还没聊过的同事也能直接转发,
 * 确认时先 create-or-get 出单聊会话再发。目标解析在这里做而不是甩给调用方,是
 * 为了让 `onConfirm(cids)` 这个契约保持不变 —— 四个调用方(消息转发/日程/会议/
 * 云文档)一行不用改就都拿到了通讯录搜索。
 */
export const ForwardDialog = ({
  conversations,
  isLoading = false,
  previewText,
  onConfirm,
  onCreateGroupForward,
  secondaryTab,
  primaryTabLabel,
  title,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  // 通讯录搜索自带防抖 + keepPreviousData;query 本身是即时的,所以会话列表
  // 过滤不会跟着防抖延迟。
  const { query, setQuery, selectable } = useDirectoryMemberSearch()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 通讯录里选中的人:userId → 展示名。存名字是为了搜索词变了、行已经不在列表
  // 里时,底部计数和后续解析仍然拿得到。
  const [selectedUsers, setSelectedUsers] = useState<Map<string, string>>(
    new Map()
  )
  const [resolving, setResolving] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [activeTab, setActiveTab] = useState<'primary' | 'secondary'>('primary')
  const searchRef = useRef<HTMLInputElement>(null)
  const toggle = (cid: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cid)) next.delete(cid)
      else next.add(cid)
      return next
    })
  const toggleUser = (id: string, name: string) =>
    setSelectedUsers((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, name)
      return next
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.name.toLowerCase().includes(q))
  }, [conversations, query])

  // 通讯录候选:仅在搜索时出现(不搜索时这里是「最近会话」,塞进整本通讯录只会
  // 干扰);已经有单聊会话的人不重复出现 —— 选上面那行会话即可。
  const directoryHits = useMemo(() => {
    if (!query.trim()) return []
    const known = new Set(
      conversations.map((c) => c.peerUserId).filter((id): id is string => !!id)
    )
    return selectable.filter((m) => !known.has(m.id))
  }, [query, selectable, conversations])

  const totalSelected = selected.size + selectedUsers.size

  const confirm = async () => {
    setResolveFailed(false)
    if (selectedUsers.size === 0) {
      onConfirm([...selected])
      return
    }
    // 通讯录选中的人还没有会话 —— 先 create-or-get(幂等,同一对用户永远同一个
    // cid),全部成功才发:失败就地提示重试,而不是发一半留下不一致的结果。
    setResolving(true)
    try {
      const cids = await Promise.all(
        [...selectedUsers.keys()].map((id) =>
          createDirectConversationByUserId(id).then((r) => r.cid)
        )
      )
      onConfirm([...selected, ...cids])
    } catch {
      setResolveFailed(true)
    } finally {
      setResolving(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={title || t('forward.title')}
      initialFocusRef={searchRef}
      maxWidth="420px"
    >
      <ModalHeader
        title={title || t('forward.title')}
        onClose={onClose}
        closeLabel={t('group.cancel')}
      />

      {secondaryTab && (
        <SegmentedControl
          value={activeTab}
          items={[
            {
              id: 'primary',
              label: primaryTabLabel || t('forward.title'),
            },
            { id: 'secondary', label: secondaryTab.label },
          ]}
          onChange={setActiveTab}
          ariaLabel={title || t('forward.title')}
          className={tabsCls}
        />
      )}

      {activeTab === 'secondary' && secondaryTab ? (
        <div className={secondaryContentCls}>{secondaryTab.content}</div>
      ) : (
        <>
          <div className={previewCls} title={previewText}>
            {previewText}
          </div>

          <div className={css({ padding: '0.5rem 1rem' })}>
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('forward.searchPlaceholder')}
              data-testid="forward-search"
            />
          </div>

          {onCreateGroupForward && (
            <InteractiveListRow
              onClick={onCreateGroupForward}
              data-testid="forward-create-group"
              divider
            >
              <span className={nameCls}>{t('forward.createGroup')}</span>
              <span aria-hidden="true" className={chevronCls}>
                ›
              </span>
            </InteractiveListRow>
          )}

          <ModalBody padding="none" minHeight="8rem">
            {filtered.length === 0 && directoryHits.length === 0 ? (
              <StateHint loading={isLoading}>
                {isLoading ? t('forward.loading') : t('forward.empty')}
              </StateHint>
            ) : (
              <>
                {/* 分组标题只在两组都可能出现时才有意义(即正在搜索);不搜索时列表
                就是「最近会话」,加个标题反而多余。 */}
                {directoryHits.length > 0 && filtered.length > 0 && (
                  <p className={sectionCls}>
                    {t('forward.sectionConversations')}
                  </p>
                )}
                {filtered.map((c) => {
                  const active = selected.has(c.cid)
                  return (
                    <SelectableListRow
                      key={c.cid}
                      onClick={() => toggle(c.cid)}
                      isSelected={active}
                      data-testid={`forward-item-${c.cid}`}
                      divider
                    >
                      {c.isGroup ? (
                        <GroupAvatar members={c.members ?? []} size="2rem" />
                      ) : (
                        <MemberAvatar
                          name={c.name}
                          src={c.avatarUrl}
                          size="2rem"
                        />
                      )}
                      <span className={nameCls}>{c.name}</span>
                    </SelectableListRow>
                  )
                })}

                {directoryHits.length > 0 && (
                  <p className={sectionCls}>{t('forward.sectionDirectory')}</p>
                )}
                {directoryHits.map((m) => {
                  const label = m.full_name || m.short_name || m.email || m.id
                  const active = selectedUsers.has(m.id)
                  const sub = [m.title, m.department?.name]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <SelectableListRow
                      key={m.id}
                      onClick={() => toggleUser(m.id, label)}
                      isSelected={active}
                      data-testid={`forward-user-${m.id}`}
                      divider
                    >
                      <MemberAvatar
                        name={label}
                        src={m.avatar_url}
                        size="2rem"
                      />
                      <span className={nameColCls}>
                        <span className={nameCls}>{label}</span>
                        {sub ? <span className={subCls}>{sub}</span> : null}
                      </span>
                    </SelectableListRow>
                  )
                })}
              </>
            )}
          </ModalBody>

          <ModalFooter>
            {resolveFailed && (
              <span className={errorCls} role="alert">
                {t('forward.resolveFailed')}
              </span>
            )}
            <Button
              variant="primary"
              size="action"
              isDisabled={totalSelected === 0 || resolving}
              loading={resolving}
              onPress={() => void confirm()}
              data-testid="forward-send"
            >
              {totalSelected > 0
                ? t('forward.sendCount', { count: totalSelected })
                : t('forward.send')}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  )
}

const tabsCls = css({
  paddingX: '1rem',
  borderBottom: '1px solid token(colors.border.default)',
})

const secondaryContentCls = css({
  flex: 1,
  minHeight: '18rem',
  padding: '1rem',
})

const previewCls = css({
  margin: '0.75rem 1rem 0',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const nameColCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  flex: 1,
  minWidth: 0,
})

const subCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const sectionCls = css({
  margin: 0,
  paddingX: '1rem',
  paddingY: '0.375rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
  backgroundColor: 'greyscale.50',
})

const errorCls = css({
  marginRight: 'auto',
  alignSelf: 'center',
  fontSize: '0.8125rem',
  color: 'error.500',
})

const chevronCls = css({
  flexShrink: 0,
  color: 'greyscale.400',
  fontSize: '1.125rem',
  lineHeight: 1,
})
