import { type CSSProperties, type ReactNode } from 'react'

import { css } from '@/styled-system/css'

/**
 * 标题栏的**统一高度**（一处定义，TitleBar / SubNavHeader / 会议模块的页头都用它）。
 *
 * `3.5rem` = 56px 是**内容高**（40px 头像 + 上下各 8px 内边距）；TitleBar 自己还有 1px
 * 底分割线，所以它量到的总高是 **57px**（下面的 `calc(3.5rem + 1px)`），会议模块的页头
 * 同理（固定区底边那条线）。走查反馈：48px 那版对消息模块偏小 —— 40px 头像上下只剩
 * 4px，太挤；57px 让头像有 8px 呼吸空间，同时六个模块（消息 / 日历 / 会议 / 审批 /
 * 任务 / 通讯录）仍然同高。
 */
export const TITLE_BAR_MIN_HEIGHT = '3.5rem'

/** 标题栏自身高度（含那 1px 底分割线），量到的就是 57px。 */
const barMinHeight = `calc(${TITLE_BAR_MIN_HEIGHT} + 1px)`

/**
 * 内容区标题栏（2026-09-17 起全站一处定义，形态照飞书聊天窗口那一栏）：
 *
 *   [图标/头像(可选)] 标题(16px bold，过长省略) 备注(可选，如「5 人」)  ……右侧动作
 *
 * 三件事写死在这里，调用点不要再自己排：
 *   ① 标题与备注**同一行、不换行** —— 原先「标题 + 人数」上下两行的地方
 *      （任务「我负责的 / 5 个任务」、通讯录「内部联系人 / 14 人」）一长就高一截；
 *   ② 标题可被挤到省略号，备注 `flexShrink: 0` 不被挤掉（人数/结果数是最该看见的）；
 *   ③ 几何统一：内边距 16/8、高 `TITLE_BAR_MIN_HEIGHT`（56 + 1px 线 = 57）、
 *      1px `border.subtle` 底分割线、白底。有 40px 前导头像时也是这个高度 ——
 *      栏高不因为放了个头像就变，头像靠 8px 内边距装进去。
 */
export const TitleBar = ({
  leading,
  title,
  onTitlePress,
  titleActionLabel,
  meta,
  paddingRight,
  children,
}: {
  /** 前导元素（会话头像 / 模块图标），可选；固定不参与挤压。 */
  leading?: ReactNode
  title: string
  /** 给了就是「点标题开设置」的可点标题。 */
  onTitlePress?: () => void
  /** 可点标题的无障碍名与 tooltip。 */
  titleActionLabel?: string
  /** 标题右侧的备注（人数 / 结果数 / 已归档这类短文），可选。 */
  meta?: ReactNode
  /** 覆盖右内边距：给需要按滚动条槽宽对齐的列表页（通讯录）。 */
  paddingRight?: string
  /** 右侧动作组。 */
  children?: ReactNode
}) => (
  <div
    className={barCls}
    style={paddingRight ? ({ paddingRight } as CSSProperties) : undefined}
    data-testid="title-bar"
  >
    {leading && (
      <span className={leadingCls} data-testid="title-bar-leading">
        {leading}
      </span>
    )}
    <div className={titleRowCls}>
      {onTitlePress ? (
        <button
          type="button"
          onClick={onTitlePress}
          title={titleActionLabel}
          aria-label={titleActionLabel}
          data-testid="title-bar-title"
          className={titleButtonCls}
        >
          {title}
        </button>
      ) : (
        <h2 className={titleTextCls} data-testid="title-bar-title">
          {title}
        </h2>
      )}
      {meta && (
        <span className={metaCls} data-testid="title-bar-meta">
          {meta}
        </span>
      )}
    </div>
    {children}
  </div>
)

const barCls = css({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  gap: 'sm',
  paddingX: 'lg',
  paddingY: 'sm',
  minHeight: barMinHeight,
  borderBottom: '1px solid token(colors.border.subtle)',
  backgroundColor: 'surface.default',
})

const leadingCls = css({ flexShrink: 0, display: 'inline-flex' })

/** 标题 + 备注一行排开：不换行，标题可省略、备注不被挤掉。 */
const titleRowCls = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  whiteSpace: 'nowrap',
})

const titleBase = {
  flexShrink: 1,
  minWidth: 0,
  textStyle: 'titleMedium',
  fontWeight: 'bold',
  color: 'text.primary',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const titleButtonCls = css({
  ...titleBase,
  display: 'block',
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { color: 'text.link' },
})

const titleTextCls = css({ ...titleBase, margin: 0 })

const metaCls = css({
  flexShrink: 0,
  textStyle: 'bodySmall',
  color: 'text.secondary',
})
