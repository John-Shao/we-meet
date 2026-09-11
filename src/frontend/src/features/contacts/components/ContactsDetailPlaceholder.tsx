import { useTranslation } from 'react-i18next'
import { RiGroupLine, RiInboxLine, RiUserSharedLine } from '@remixicon/react'

import { css } from '@/styled-system/css'

import type { ContactsView } from './ContactsSidebar'

interface Props {
  view: ContactsView
}

/**
 * 右栏占位。
 *
 * 存在的理由是**版面**:以前没有任何东西被选中时右栏整块不渲染,中栏因此从
 * ~660px 撑到 ~1000px —— 选人/取消选择、切到群组视图(Y 原来压根没有右栏)都会
 * 让列表宽度跳一次,滚动位置和视觉锚点全跟着跳。现在右栏恒定占位,三栏宽度不再
 * 随选择变化。
 *
 * 顺带把「这块是干什么的」讲清楚:不同视图给不同的下一步提示。
 */
export const ContactsDetailPlaceholder = ({ view }: Props) => {
  const { t } = useTranslation('contacts')

  const content: { Icon: typeof RiInboxLine; title: string; hint: string } =
    view === 'groups'
      ? {
          Icon: RiGroupLine,
          title: t('groups.title'),
          hint: t('groups.selectHint'),
        }
      : view === 'external'
        ? {
            Icon: RiUserSharedLine,
            title: t('external.title'),
            hint: t('external.hint'),
          }
        : {
            Icon: RiInboxLine,
            title: t('detail.emptyTitle'),
            hint: t('detail.emptyHint'),
          }

  return (
    <aside className={panelCls} data-testid="contacts-detail-placeholder">
      <div className={iconCls} aria-hidden>
        <content.Icon size={24} />
      </div>
      <p className={titleCls}>{content.title}</p>
      <p className={hintCls}>{content.hint}</p>
    </aside>
  )
}

const panelCls = css({
  width: '300px',
  flexShrink: 0,
  height: '100%',
  borderLeft: '1px solid token(colors.greyscale.200)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '1.5rem',
  textAlign: 'center',
})
const iconCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '48px',
  height: '48px',
  borderRadius: '12px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.500',
})
const titleCls = css({
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 'medium',
  color: 'greyscale.700',
})
const hintCls = css({
  margin: 0,
  fontSize: '0.75rem',
  lineHeight: 1.5,
  color: 'greyscale.500',
})
