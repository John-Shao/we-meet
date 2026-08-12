/**
 * Shared field styles for the event form (P2) and the blocks embedded in it.
 *
 * Lifted out of `CreateEventDialog` so the meeting-room block (P9) can look
 * like it belongs there instead of carrying a near-copy of the same rules.
 */

import { css } from '@/styled-system/css'

/**
 * 单行输入(标题 / 起止时间 / 重复截止 / 会议室搜索),以及与 `selectChrome`
 * 叠加后的「重复」下拉。
 *
 * 高度钉在 control.md(32px),与 selectChrome / Input 基元 / Button sm 同档
 * (见 panda.config 的 sizes.control)。原先高度靠 padding + 继承行高算出来
 * ≈37px,而同一栏的 select 已经钉成 32px,一个表单里两种控件高度。
 *
 * ⚠️ 钉高必须**同时把 paddingY 去掉**:panda reset 给表单控件写了
 * `font: inherit`,行高从 html 继承成 1.5 → 0.875rem 的行盒是 21px;留着
 * 上下各 8px 的话内容盒只剩 32 −(8+8)− 边框 2 = 14px,21 塞进 14,文字会被
 * 上下切掉(汉字切得最狠,拉丁文只丢降部,所以英文截图看不出来)。这正是
 * selectChrome 踩过的坑,见那边的注释。单行控件的文字由浏览器在元素盒内
 * 垂直居中,不需要 paddingY 来摆位。多行的 textarea 不适用,别照抄。
 */
export const inputCls = css({
  width: '100%',
  height: 'control.md',
  minHeight: 'control.md',
  paddingX: '0.75rem',
  paddingBlock: 0,
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
