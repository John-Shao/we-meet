/**
 * 管理端层级树共用的样式(部门树 / 会议室节点树)。
 *
 * 两棵树是同一种控件:可折叠层级 + 行尾动作图标。行尾图标钮此前在两个文件里
 * 各写了一份、逐字相同,这里收成一处。
 */

import { css } from '@/styled-system/css'

/** 树行尾的动作图标钮(展开箭头 / 新建 / 编辑 / 删除)。 */
export const treeIconBtn = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.5rem',
  height: '1.75rem',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  borderRadius: '4px',
  _hover: { backgroundColor: 'greyscale.200', color: 'greyscale.800' },
})
