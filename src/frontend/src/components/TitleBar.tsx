import { type CSSProperties, type ReactNode } from 'react'

import { css } from '@/styled-system/css'

/**
 * 内容区标题栏（2026-09-17 起全站一处定义，形态照飞书聊天窗口那一栏）：
 *
 *   [图标/头像(可选)] 标题(16px bold，过长省略) 备注(可选，如「5 人」)  ……右侧动作
 *
 * 三件事写死在这里，调用点不要再自己排：
 *   ① 标题与备注**同一行、不换行** —— 原先「标题 + 人数」上下两行的地方
 *      （任务「我负责的 / 5 个任务」、通讯录「内部联系人 / 14 人」）一长就高一截；
 *   ② 标题可被挤到省略号，备注 `flexShrink: 0` 不被挤掉（人数/结果数是最该看见的）；
 *   ③ 几何统一：**栏高一律 48px**（`controlHeight.large`，与二级导航栏、任务/通讯录/
 *      审批、会议四个一级页的标题栏同高）、1px 底分割线、白底。无前导时靠 8px 纵向
 *      内边距撑到 48；有 40px 前导头像时内边距收到 4px —— 48 是这个栏的**高度基准**，
 *      不因为放了个头像就长高。
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
    style={
      {
        ...(paddingRight ? { paddingRight } : {}),
        // 40px 前导装进 48px 的栏:上下各 4px(内联样式,不与 barCls 抢同一个原子类)。
        ...(leading ? { paddingTop: '4px', paddingBottom: '4px' } : {}),
      } as CSSProperties
    }
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
  minHeight: 'controlHeight.large',
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
