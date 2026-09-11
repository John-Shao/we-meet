import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { RiSearchLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { Button } from '@/primitives'
import { StateHint } from '@/components/StateHint'
import { GroupAvatar } from '@/features/im/components/GroupAvatar'
import { imConversationTimeLabel } from '@/features/im/components/imTimeLabels'

import { resolveGroupName } from '../groups'
import { useMyGroups } from '../hooks/useMyGroups'

interface Props {
  /** 当前选中的群(右栏群资料的依据),来自 URL ?group=。 */
  selectedCid: string | null
  /** 点一行 = 选中(不直接跳转):与成员行同一套手感,跳转交给行内按钮。 */
  onSelect: (cid: string) => void
}

/**
 * 「我的群组」——通讯录里的群清单(对标飞书通讯录的同名分组)。
 *
 * 零后端:群清单与成员名/头像都来自 useMyGroups(即 IM 会话缓存),所以从 /im
 * 切过来是命中缓存、不重新拉。
 *
 * 这一版补齐了与消息页的口径差:
 *   - 群头像带 customSrc(以前会话列表用群主设的头像、通讯录用九宫格拼图,同一个
 *     群在两处长得不一样);
 *   - 补最后活跃时间与未读红点(与会话列表同一套分档与配色);
 *   - 没名字的群不再一律叫「未命名群聊」,而是用成员名拼「张三、李四等 3 人」。
 */
export const MyGroupsPanel = ({ selectedCid, onSelect }: Props) => {
  const { t, i18n } = useTranslation(['contacts', 'im'])
  const [, navigate] = useLocation()
  const { groups, memberInfo, groupAvatars, selfUid, isLoading } = useMyGroups()
  const [query, setQuery] = useState('')

  const separator = t('groups.nameSeparator')

  // cid → 显示名。一次算完(map 而不是每行 find),语言切换会整棵重渲染。
  const labels = useMemo(
    () =>
      new Map(
        groups.map((c) => {
          const resolved = resolveGroupName(c, memberInfo, {
            selfUid,
            separator,
          })
          const label =
            resolved.kind === 'named'
              ? resolved.name
              : resolved.kind === 'derived'
                ? t('groups.unnamedFromMembers', {
                    names: resolved.names,
                    count: resolved.count,
                  })
                : t('groups.unnamed')
          return [c.cid, label] as const
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, memberInfo, selfUid, separator]
  )
  const labelOf = useCallback(
    (cid: string) => labels.get(cid) ?? t('groups.unnamed'),
    // t() 不进依赖:语言切换会整棵重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels]
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((c) => labelOf(c.cid).toLowerCase().includes(q))
  }, [groups, query, labelOf])

  const enterGroup = (cid: string) =>
    navigate(`/im?cid=${encodeURIComponent(cid)}`)

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      })}
    >
      <header className={headerCls}>
        <div className={css({ minWidth: 0 })}>
          <h2 className={titleCls}>{t('groups.title')}</h2>
          <p className={subtitleCls}>
            {t('groups.total', { count: groups.length })}
          </p>
        </div>
        <label className={searchWrapCls}>
          <RiSearchLine size={14} aria-hidden className={searchIconCls} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('groups.searchPlaceholder')}
            aria-label={t('groups.searchPlaceholder')}
            data-testid="contacts-groups-search"
            className={searchInputCls}
          />
        </label>
      </header>

      <div className={css({ overflowY: 'auto', flex: 1 })}>
        {isLoading && groups.length === 0 ? (
          <StateHint state="loading">{t('page.loading')}</StateHint>
        ) : visible.length === 0 ? (
          <StateHint>
            {groups.length === 0 ? t('groups.empty') : t('groups.noMatch')}
          </StateHint>
        ) : (
          <ul className={listCls}>
            {visible.map((c) => {
              const selected = selectedCid === c.cid
              const label = labelOf(c.cid)
              return (
                <li
                  key={c.cid}
                  className={cx(
                    rowCls,
                    css({
                      backgroundColor: selected
                        ? 'greyscale.200'
                        : 'transparent',
                    })
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(c.cid)}
                    data-testid={`contacts-group-${c.cid}`}
                    className={rowMainCls}
                  >
                    <GroupAvatar
                      members={c.members.slice(0, 9).map((uid) => ({
                        name: memberInfo[uid]?.full_name || '',
                        src: memberInfo[uid]?.avatar_url || undefined,
                      }))}
                      customSrc={groupAvatars[c.cid]}
                      size="2.5rem"
                    />
                    <span className={textColCls}>
                      <span className={line1Cls}>
                        <span className={nameCls}>{label}</span>
                        {!!c.last_message_ts && (
                          <span className={timeCls}>
                            {imConversationTimeLabel(
                              c.last_message_ts,
                              i18n.language,
                              t('im:time.yesterday')
                            )}
                          </span>
                        )}
                      </span>
                      <span className={line2Cls}>
                        <span className={metaCls}>
                          {t('groups.memberCount', {
                            count: c.members.length,
                          })}
                        </span>
                        {c.unread_count > 0 &&
                          (c.muted ? (
                            // 免打扰:只显小灰点,不显数字(与消息页同一口径)。
                            <span
                              aria-label={t('page.unreadBadge', {
                                count: c.unread_count,
                              })}
                              className={mutedDotCls}
                            />
                          ) : (
                            <span
                              aria-label={t('page.unreadBadge', {
                                count: c.unread_count,
                              })}
                              className={unreadCls}
                            >
                              {c.unread_count > 99 ? '99+' : c.unread_count}
                            </span>
                          ))}
                      </span>
                    </span>
                  </button>
                  <span data-row-action className={rowActionCls}>
                    <Button
                      variant="secondary"
                      size="dense"
                      onPress={() => enterGroup(c.cid)}
                      data-testid={`contacts-group-enter-${c.cid}`}
                    >
                      {t('groups.open')}
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  paddingX: '1rem',
  paddingY: '0.625rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  margin: 0,
  fontSize: '0.9375rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
  whiteSpace: 'nowrap',
})
const subtitleCls = css({
  margin: '0.125rem 0 0',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const searchWrapCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  width: '14rem',
  maxWidth: '50%',
  flexShrink: 0,
  paddingX: '0.5rem',
  paddingY: '0.3125rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  // 里层 input 无边框无 outline,聚焦提示落在这一圈上。
  _focusWithin: { borderColor: 'border.focus' },
})
const searchIconCls = css({ flexShrink: 0, color: 'greyscale.500' })
const searchInputCls = css({
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'default.text',
  fontSize: '0.8125rem',
  padding: 0,
})
const listCls = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  // 超宽屏上不给行宽无限拉长:名字与行尾按钮之间不留几百像素的空档。
  maxWidth: '60rem',
})
const rowCls = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  borderBottom: '1px solid token(colors.greyscale.100)',
  _hover: {
    backgroundColor: 'greyscale.50',
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
  },
  _focusWithin: {
    '& [data-row-action]': { opacity: 1, pointerEvents: 'auto' },
  },
})
const rowMainCls = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '1rem',
  paddingY: '0.625rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
})
const textColCls = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
})
const line1Cls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})
const line2Cls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})
const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.875rem',
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const timeCls = css({
  flexShrink: 0,
  fontSize: '0.6875rem',
  color: 'greyscale.500',
})
const metaCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.75rem',
  color: 'greyscale.500',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const unreadCls = css({
  flexShrink: 0,
  paddingX: '0.5rem',
  paddingY: '0.0625rem',
  borderRadius: '999px',
  fontSize: '0.6875rem',
  fontVariantNumeric: 'tabular-nums',
  backgroundColor: 'primary.500',
  color: 'white',
})
const mutedDotCls = css({
  flexShrink: 0,
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '999px',
  backgroundColor: 'greyscale.400',
})
/** 行尾动作:hover / 键盘聚焦才出现(触屏常显)—— 与成员行同一手法。 */
const rowActionCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: '6rem',
  paddingRight: '1rem',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease',
  '@media (hover: none)': { opacity: 1, pointerEvents: 'auto' },
})
