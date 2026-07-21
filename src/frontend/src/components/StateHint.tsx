import type { ReactNode } from 'react'
import { css, cx } from '@/styled-system/css'

/**
 * 统一的「加载 / 空」占位:居中灰字 + 一致留白。loading 时前置一个小转圈
 * (复用 panda 的 rotate keyframe)。各模块原先散落的 padding/color/居中
 * 各写一套,统一到这里,深浅色都走 greyscale token 自动适配。
 */
const wrap = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '1.5rem',
  color: 'greyscale.500',
  fontSize: '0.875rem',
  textAlign: 'center',
})

const spinner = css({
  flexShrink: 0,
  width: '1rem',
  height: '1rem',
  borderRadius: '999px',
  border: '2px solid',
  borderColor: 'greyscale.300',
  borderTopColor: 'greyscale.500',
  animation: 'rotate 700ms linear infinite',
})

interface Props {
  children: ReactNode
  /** true 时前置转圈,用于加载态;false(默认)为空态。 */
  loading?: boolean
  /** 额外类名(如覆盖 padding/对齐以贴合特定容器)。 */
  className?: string
}

export const StateHint = ({ children, loading = false, className }: Props) => (
  <div className={cx(wrap, className)} role="status">
    {loading && <span className={spinner} aria-hidden="true" />}
    <span>{children}</span>
  </div>
)
