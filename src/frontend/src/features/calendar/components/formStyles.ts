/**
 * Shared field styles for the event form (P2) and the blocks embedded in it.
 *
 * Lifted out of `CreateEventDialog` so the meeting-room block (P9) can look
 * like it belongs there instead of carrying a near-copy of the same rules.
 */

import { css } from '@/styled-system/css'

export const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

export const fieldCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  flex: 1,
  minWidth: '12rem',
})

export const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })

export const chipCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.100',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
})

/**
 * 字段右上角的文字按钮(会议室「更换 / 添加」/ 参与者「批量添加」)。
 *
 * 刻意**不**走 Button 基元:基元每个 size 刻度都带 paddingX,而这个按钮要跟
 * 下方字段一起齐右边缘,套上去文字会被内边距推离边缘、和字段右沿错开。
 * 它是行内文字链而不是按钮盒子,所以留一份共享样式;跨 feature 直接 import
 * 本文件(会议室块就是这么用 chipCls/labelCls 的),别再各自抄一份。
 */
export const linkBtnCls = css({
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  _dark: { color: 'primaryDark.700' },
})
