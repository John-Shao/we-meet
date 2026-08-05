import { css } from '@/styled-system/css'

/**
 * 群面板拆成 root 与二级页之后,**两边都要用**的样式常量。
 *
 * 只收跨切分线的那两个:root 独有的(`inputCls`/`sectionCls`/`sectionHead`/
 * `editActions`)留在 `GroupInfoPanel`,成员页独有的(`memberSearchCls`)跟着
 * 搬进 `GroupMembersPage`。`chips.ts` 是同一手法的先例。
 */

/** 无边框图标按钮:root 的重命名/改描述铅笔,成员页的「＋」。 */
export const editBtn = css({
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  fontSize: '0.875rem',
  _hover: { color: 'primary.500' },
})

/** 小节标题的灰字。 */
export const sectionLabel = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
