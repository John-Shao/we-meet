/**
 * 跨模块共用的控件样式——不足以做成组件、但绝不该各处抄一份的那些。
 */

import { css } from '@/styled-system/css'

/**
 * 信息行/字段行里的行内文字动作(会议室「更换」、参与者「批量添加」、
 * 会议号与链接的「复制」)。
 *
 * 刻意**不**走 Button 基元:基元每个 size 刻度都带 paddingX,而这类按钮要跟
 * 同行的值或下方字段一起齐边缘,套上去文字会被内边距推开、对不齐。它是行内
 * 文字链而不是按钮盒子。
 *
 * 原先散成三份:calendar 的 formStyles.linkBtnCls、meeting-rooms 的同名副本
 * (逐字相同),外加两个「复制」各自的写法——一个纯蓝链、一个灰框盒子,同一个
 * 动作两种长相。统一按文字链收口:文案会在「复制 → 已复制」之间变宽,盒子会
 * 跟着跳一下,链接不会;而且这两处所在的面板里已经有真正的主操作
 * (「进入会议」),复制这种低承诺、可重复的微动作不该跟它抢分量。
 *
 * 住在 styles/ 而不是某个 feature 下:已有 calendar、meeting-rooms、meetings
 * 三个模块在用,挂在任一模块里都会让第四个使用者犹豫,然后再抄一份。
 */
/**
 * 翻页箭头 ‹ › 的字形大小(日历工具栏 / 迷你日历 / 会话忙闲面板)。
 *
 * 这三处的内容是**文字字符**而不是图标组件,所以盒子交给基元的 icon* 档之后
 * 字号仍得显式给 —— 不给就退回继承正文 16px,‹ › 本身字形偏小,只剩几个像素。
 *
 * 归位前 CalendarToolbar 是 1.375rem、另两处 1.25rem,而工具栏的注释明写着要
 * 「与 MiniCalendar 同用 ‹ › 字形」—— 意图本来就是一致,只是数值没对上。
 */
export const navGlyphCls = css({ fontSize: '1.25rem', lineHeight: 1 })

export const linkBtnCls = css({
  // 同行的值多为 flex:1,不锁住会被挤扁。
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: 'primary.500',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  // 蓝字 + hover 下划线是这类裸链接唯一的可点提示,不能两个都不给。
  _hover: { textDecoration: 'underline' },
  // primary.* 是固定色阶不随主题翻转,深底上翻到 primaryDark 亮蓝保证可读。
  _dark: { color: 'primaryDark.700' },
})
