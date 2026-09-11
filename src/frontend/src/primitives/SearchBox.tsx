import type { ChangeEvent, Ref } from 'react'
import { RiSearchLine } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'

/**
 * 全站统一的搜索框 —— 基准是「日历 → 会议室」筛选行里那一个,长相与它逐项相同:
 * 1px 灰描边(greyscale.300,随主题翻转)、圆角 4px、高 32px(control.md,与同行的
 * Select / Button 齐平)、13px 字号,放大镜画在**框内右端**。
 *
 * 为什么收成一个组件:同一款搜索框原先有三份各自为政的实现 —— 通讯录侧栏、成员筛选、
 * 我的群组是一套「边框画在外层 label 上、图标在左、圆角 6px」的两层结构,两个选择器
 * 弹窗则各用 Input 基元(无图标,圆角还是 radii.field)。要「一致」就得只有一处定义,
 * 否则改了一处另两处照旧。
 *
 * 焦点态**不在这里**:styles/index.css 的「统一焦点描边」① 会给所有原生 input(含
 * `type="search"`)加蓝描边 + 柔光环,那条规则未分层,盖得住 panda 的 utilities ——
 * 在这里写 `_focus` 等于白写。选 `type="search"` 而不是 text 也是为了语义(读屏念
 * searchbox)与 Esc 清空;原生 ✕ 已由 panda preflight 的 `-webkit-appearance: none`
 * 收掉(见 MeetingRoomFilters 的注释),框内右端这块地方留给放大镜。
 */
export const SearchBox = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
  inputRef,
  className,
}: {
  value: string
  /** 直接传 setState 即可:回调只给字符串,不给事件。 */
  onChange: (value: string) => void
  placeholder: string
  /** 不给就用占位符当无障碍名。 */
  ariaLabel?: string
  testId?: string
  inputRef?: Ref<HTMLInputElement>
  /** 只用来定宽度 / 外边距这类排布,外观不要再从这里改。 */
  className?: string
}) => (
  <label className={cx(boxCls, className)}>
    <input
      ref={inputRef}
      type="search"
      className={inputCls}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value)
      }
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      data-testid={testId}
    />
    <RiSearchLine size={14} aria-hidden className={iconCls} />
  </label>
)

/**
 * 宽度刻意不钉:侧栏与弹窗要撑满、表头筛选是 14rem,各不相同 —— 钉死一个值总有容器
 * 被撑破(窄侧栏、小弹窗、响应式断点)。`display: flex` 而不是 inline-flex,是为了让
 * 不给宽度的调用点按块级撑满,与它们改前的行为一致。
 */
const boxCls = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
})
/**
 * 框本体。
 *
 * `paddingRight: 1.75rem` 必须留:放大镜浮在右端,不留位时输到末尾的文字会钻到图标
 * 底下。`paddingBlock: 0` 是因为高度钉了 control.md —— 留着纵向内边距会把文字上下切掉
 * (理由同 primitives/selectChrome.ts)。
 */
const inputCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.8125rem',
  height: 'control.md',
  minHeight: 'control.md',
  paddingBlock: 0,
  paddingLeft: '0.625rem',
  paddingRight: '1.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: 4,
  backgroundColor: 'greyscale.000',
  color: 'default.text',
})
/**
 * `pointerEvents: 'none'` 不能省:图标浮在 input 之上,否则点它、从它上面起手拖选文字
 * 都会被这层 svg 吃掉,光标也落不到输入框上。它只是「这是个搜索框」的视觉提示,不是
 * 按钮 —— 用它的页面都是边打边筛。
 */
const iconCls = css({
  position: 'absolute',
  right: '0.5rem',
  color: 'greyscale.500',
  pointerEvents: 'none',
})
