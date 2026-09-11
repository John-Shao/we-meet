import { useTranslation } from 'react-i18next'
import type { ConversationSummary } from '@jusi/light-im-sdk'
import { RiMessage3Line } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import type { ImUserInfo } from '@/features/im/api/resolveImUsers'
import { GroupAvatar } from '@/features/im/components/GroupAvatar'

import { MemberAvatar } from './MemberAvatar'

interface Props {
  group: ConversationSummary
  /** 已解析好的群名(群主设的名字,或由成员名推出来的)。 */
  label: string
  /** uid → 名字/头像;取不到名字的成员会被跳过。 */
  memberInfo: Record<string, ImUserInfo>
  /** 群主设置的自定义头像(与会话列表同一个来源)。 */
  avatarSrc?: string
  /** 进入会话 /im?cid=… —— 群里真正的管理动作在会话里,这里只做「看资料」。 */
  onEnter: () => void
}

/**
 * 右栏的群资料卡。
 *
 * 以前「我的群组」视图没有右栏:点一行直接跳到 /im,于是那个视图永远是两栏,
 * 而成员视图是三栏 —— 切视图时中栏宽度会跳。现在群和成员一样「点行 = 右栏预览、
 * 按钮 = 进会话」,三个视图的版面与手感统一。
 *
 * 只展示,不管理:成员增删/退群/改群名都在会话侧,免得通讯录变成第二个管理入口。
 */
export const GroupDetailPanel = ({
  group,
  label,
  memberInfo,
  avatarSrc,
  onEnter,
}: Props) => {
  const { t } = useTranslation('contacts')

  const members = group.members
    .map((uid) => ({ uid, info: memberInfo[uid] }))
    .filter((m) => !!m.info?.full_name?.trim())

  return (
    <aside className={panelCls} data-testid="contacts-group-detail">
      <div className={headerCls}>
        <GroupAvatar
          members={group.members.slice(0, 9).map((uid) => ({
            name: memberInfo[uid]?.full_name || '',
            src: memberInfo[uid]?.avatar_url || undefined,
          }))}
          customSrc={avatarSrc}
          size="72px"
        />
        <h2 className={nameCls}>{label}</h2>
        <p className={metaCls}>
          {t('groups.memberCount', { count: group.members.length })}
        </p>
      </div>

      {members.length > 0 && (
        <div className={sectionCls}>
          <h3 className={sectionTitleCls}>{t('groups.members')}</h3>
          <ul className={listCls}>
            {members.map(({ uid, info }) => (
              <li key={uid} className={memberRowCls}>
                <MemberAvatar
                  name={info?.full_name || ''}
                  src={info?.avatar_url || undefined}
                  size="24px"
                />
                <span className={memberNameCls}>{info?.full_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={footerCls}>
        <Button
          variant="primary"
          onPress={onEnter}
          data-testid="contacts-group-enter"
          className={css({ width: '100%' })}
        >
          <RiMessage3Line size={16} aria-hidden />
          {t('groups.open')}
        </Button>
      </div>
    </aside>
  )
}

const panelCls = css({
  width: '300px',
  flexShrink: 0,
  height: '100%',
  borderLeft: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
})
const headerCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '1.25rem',
  paddingTop: '1.25rem',
  paddingBottom: '1rem',
  textAlign: 'center',
})
const nameCls = css({
  margin: 0,
  fontSize: '1.0625rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
  wordBreak: 'break-word',
})
const metaCls = css({
  margin: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})
const sectionCls = css({
  paddingX: '1.25rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.100)',
})
const sectionTitleCls = css({
  margin: '0 0 0.5rem',
  fontSize: '0.75rem',
  fontWeight: '600',
  color: 'greyscale.500',
})
const listCls = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})
const memberRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
})
const memberNameCls = css({
  minWidth: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.800',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const footerCls = css({ marginTop: 'auto', padding: '1.25rem' })
