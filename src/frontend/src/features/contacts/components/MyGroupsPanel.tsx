import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'
import { useImConnection } from '@/features/im/hooks/useImConnection'
import { useConversations } from '@/features/im/hooks/useConversations'
import { GroupAvatar } from '@/features/im/components/GroupAvatar'
import { resolveImUsers } from '@/features/im/api/resolveImUsers'
import { fetchImToken } from '@/features/im/api/fetchImToken'

/**
 * 「我的群组」——通讯录里的群清单(对标飞书通讯录的同名分组)。
 *
 * 零后端:群列表就是 IM 会话列表里 type==='group' 的那部分,复用会话列表已有的
 * 查询缓存(同一个 queryKey),所以从 /im 切过来是命中缓存、不重新拉。IM Client
 * 本身是单例,页面里第一次用会自动 connect —— 但正常路径下消息页早已连上。
 *
 * 点一行走 `/im?cid=<cid>` 深链,而不是在这里再造一套聊天视图。
 */
export const MyGroupsPanel = () => {
  const { t } = useTranslation('contacts')
  const [, navigate] = useLocation()
  const { client } = useImConnection()
  // 与 ImRoute 同一个 queryKey,所以消息页拉过就直接命中缓存。
  const { data: tokenData } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    staleTime: 60_000,
  })
  const { data: conversations = [], isLoading } = useConversations(
    client,
    tokenData?.uid ?? ''
  )

  const groups = useMemo(
    () => conversations.filter((c) => c.type === 'group'),
    [conversations]
  )

  const [query, setQuery] = useState('')

  // 群头像九宫格要每个群前 9 名成员的名字/头像 —— 与会话列表同一个 queryKey,
  // 那边已经拉过就直接命中缓存。
  const memberUids = useMemo(
    () => Array.from(new Set(groups.flatMap((c) => c.members.slice(0, 9)))),
    [groups]
  )
  const { data: memberInfo = {} } = useQuery({
    queryKey: ['im', 'group-member-info', memberUids],
    queryFn: () => resolveImUsers(memberUids),
    enabled: memberUids.length > 0,
    staleTime: 60_000,
  })

  const nameOf = (name: string | undefined) =>
    name && name.trim() ? name : t('groups.unnamed')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((c) => nameOf(c.name).toLowerCase().includes(q))
    // nameOf 只读 t(),不进依赖 —— 语言切换会整棵重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, query])

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      })}
    >
      <div className={headerCls}>
        <h2 className={titleCls}>
          {t('groups.title')} ({groups.length})
        </h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('groups.searchPlaceholder')}
          aria-label={t('groups.searchPlaceholder')}
          data-testid="contacts-groups-search"
          className={searchCls}
        />
      </div>

      <div className={css({ overflowY: 'auto', flex: 1 })}>
        {isLoading && groups.length === 0 ? (
          <StateHint loading>{t('page.loading')}</StateHint>
        ) : visible.length === 0 ? (
          <StateHint>
            {groups.length === 0 ? t('groups.empty') : t('groups.noMatch')}
          </StateHint>
        ) : (
          <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
            {visible.map((c) => (
              <li key={c.cid}>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/im?cid=${encodeURIComponent(c.cid)}`)
                  }
                  className={rowCls}
                >
                  <GroupAvatar
                    members={c.members.slice(0, 9).map((uid) => ({
                      name: memberInfo[uid]?.full_name || '',
                      src: memberInfo[uid]?.avatar_url || undefined,
                    }))}
                    size="2.5rem"
                  />
                  <span className={css({ minWidth: 0, textAlign: 'left' })}>
                    <span className={rowNameCls}>{nameOf(c.name)}</span>
                    <span className={rowMetaCls}>
                      {t('groups.memberCount', { count: c.members.length })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
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
const searchCls = css({
  width: '14rem',
  maxWidth: '50%',
  padding: '0.375rem 0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.8125rem',
})
const rowCls = css({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  paddingX: '1rem',
  paddingY: '0.625rem',
  border: 'none',
  borderBottom: '1px solid token(colors.greyscale.100)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.50' },
})
const rowNameCls = css({
  display: 'block',
  fontSize: '0.875rem',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const rowMetaCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
