import { type ReactNode } from 'react'

import { css } from '@/styled-system/css'

/**
 * 聊天窗口标题栏（2026-09-17 按飞书那一栏改的形态）：
 *
 *   [头像] 标题(粗体，过长省略)  备注(可选，如「5 人」)        ……右侧动作
 *
 * 三件事是**写死在这一处**的，调用点不要再自己排：
 *   ① 头像在最左，固定 24px 不参与挤压；
 *   ② 标题与备注**同一行、不换行** —— 原先备注是标题下面的一行，标题一长整栏就
 *      高一截，与飞书那种「一行读完」的观感不一致；
 *   ③ 标题可以被挤到省略号，备注 `flexShrink: 0` 不被挤掉（人数是这一栏里最该
 *      看见的信息）。
 *
 * Title stays a `<button>` when `onOpenSettings` is given（群聊点名字开设置），
 * otherwise a plain div —— 私聊没有那个面板。
 */
export const ChatHeader = ({
  title,
  avatar,
  meta,
  onOpenSettings,
  settingsLabel,
  children,
}: {
  title: string
  /** 会话头像：群聊用成员拼图，私聊用对端头像（调用点决定）。 */
  avatar: ReactNode
  /** 标题右侧的备注，可空（群人数 / 已离职提示）。 */
  meta?: ReactNode
  /** 给了就是「点标题开设置」的群聊形态。 */
  onOpenSettings?: () => void
  /** 点标题那颗按钮的无障碍名。 */
  settingsLabel?: string
  /** 右侧动作组（通话 / 会议 / 添加成员 / ⋯）。 */
  children?: ReactNode
}) => (
  <div className={headerCls}>
    <span className={avatarCls} data-testid="chat-header-avatar">
      {avatar}
    </span>
    <div className={titleRowCls}>
      {onOpenSettings ? (
        <button
          type="button"
          onClick={onOpenSettings}
          title={settingsLabel}
          aria-label={settingsLabel}
          data-testid="chat-group-title"
          className={titleButtonCls}
        >
          {title}
        </button>
      ) : (
        <div className={titleTextCls} data-testid="chat-direct-title">
          {title}
        </div>
      )}
      {meta && (
        <span className={metaCls} data-testid="chat-header-meta">
          {meta}
        </span>
      )}
    </div>
    {children}
  </div>
)

const headerCls = css({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.625rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  minHeight: '3rem',
})

const avatarCls = css({ flexShrink: 0, display: 'inline-flex' })

/** 标题 + 备注一行排开：不换行，标题可省略、备注不被挤掉。 */
const titleRowCls = css({
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  whiteSpace: 'nowrap',
})

const titleBase = {
  flexShrink: 1,
  minWidth: 0,
  fontWeight: 'bold',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const titleButtonCls = css({
  ...titleBase,
  display: 'block',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { color: 'primary.500' },
})

const titleTextCls = css(titleBase)

const metaCls = css({
  flexShrink: 0,
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
