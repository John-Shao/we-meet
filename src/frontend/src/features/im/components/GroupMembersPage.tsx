import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Client, ConversationSummary } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import { removeMember } from '../api/removeMember'
import { useGroupRoster } from '../hooks/useGroupRoster'
import { Avatar } from './Avatar'
import { brandChipCls, neutralChipCls } from './chips'
import { editBtn, sectionLabel } from './panelStyles'

interface Props {
  client: Client
  conversation: ConversationSummary
  currentUserUID: string
  /** Opens the add-members dialog (＋ next to the member count). */
  onAddMembers: () => void
}

/**
 * 群成员 —— 名单从 `GroupInfoPanel` 内联的一段搬成独立二级页(对标飞书),
 * 与「群机器人 ›」同级。搬家的动机是**名单只该有一处**。
 *
 * 这一页自己管 `busy`:它与 root 的退群/清空历史不会同屏出现,共用一个
 * 忙标志已无意义。
 */
export const GroupMembersPage = ({
  client,
  conversation,
  currentUserUID,
  onAddMembers,
}: Props) => {
  const { t } = useTranslation('im')
  const { confirm: askConfirm, alert: showAlert } = useConfirm()
  const cid = conversation.cid
  const isOwner = conversation.owner_uid === currentUserUID
  const { roster, isLoading, names, nameOf, refresh } = useGroupRoster(
    client,
    cid,
    currentUserUID,
  )
  const [busy, setBusy] = useState(false)

  // 群成员搜索。搜的是**这个群里显示的那个名字** —— 群昵称优先、目录名兜底,
  // 与名单上看到的一致;搜不到自己刚看见的名字比没有搜索还费解。
  // 小群不出搜索框:三个人的名单上顶一个输入框纯属噪音。
  const [memberQuery, setMemberQuery] = useState('')
  const searchableRoster = roster.length > MEMBER_SEARCH_THRESHOLD
  const visibleRoster = (() => {
    const q = memberQuery.trim().toLowerCase()
    if (!q || !searchableRoster) return roster
    return roster.filter((m) => nameOf(m.uid).toLowerCase().includes(q))
  })()

  const onError = (e: unknown) =>
    void showAlert({
      message: t('manage.error', {
        message: e instanceof Error ? e.message : String(e),
      }),
    })

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

  return (
    <>
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
      {searchableRoster && (
        <div className={css({ paddingX: '1rem', paddingBottom: '0.5rem' })}>
          <input
            type="search"
            value={memberQuery}
            onChange={(e) => setMemberQuery(e.target.value)}
            placeholder={t('manage.searchMembers')}
            aria-label={t('manage.searchMembers')}
            data-testid="group-member-search"
            className={memberSearchCls}
          />
        </div>
      )}
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
        ) : visibleRoster.length === 0 ? (
          <li
            className={css({ padding: '0.5rem 1rem', color: 'greyscale.500' })}
          >
            {t('manage.noMemberMatch')}
          </li>
        ) : (
          visibleRoster.map((m) => {
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
                <Avatar name={label} src={names[m.uid]?.avatar_url} size="2rem" />
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
                  <span className={brandChipCls}>{t('manage.owner')}</span>
                )}
                {/* P10:人离职了群里不会自动少一个人 —— 群成员关系归 jusi,
                    组织关系归 we-meet,两者本就不同步。名单上标出来,群主才
                    知道该清谁。用中性灰,不是错误态。 */}
                {names[m.uid]?.left && (
                  <span className={neutralChipCls}>{t('departed.chip')}</span>
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
    </>
  )
}

/** 成员数超过这个值才出搜索框 —— 少于一屏的名单上顶个输入框纯属噪音。 */
const MEMBER_SEARCH_THRESHOLD = 10

const memberSearchCls = css({
  width: '100%',
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.8125rem',
})
