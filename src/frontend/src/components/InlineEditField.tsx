import { forwardRef } from 'react'

/**
 * 行内编辑的纯展示字段:`input` 或 `textarea`,不带任何状态与按钮。
 *
 * 提交/取消的语义在 `@/hooks/useInlineEdit`(无按钮:Enter 保存、Esc 取消、
 * 失焦自动保存)。这里只负责把 ref/value/键盘/失焦接到字段上,以及多行与单行的
 * 形态切换。错误/「保存中」这类状态行由**调用方**自行渲染(账号管理的
 * `EditableRow` 已有 `editErrorCls`;群面板走 alert,不需要内联状态)。
 *
 * `onKeyDown`/`onBlur` 刻意收窄成最小结构类型(`{ key, stopPropagation }` /
 * `() => void`):这样同一个处理器既能挂到 input 也能挂到 textarea,不用在调用点
 * 做 `HTMLInputElement | HTMLTextAreaElement` 的逆变强转。
 */
interface InlineEditFieldProps {
  multiline?: boolean
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: { key: string; stopPropagation: () => void }) => void
  onBlur: () => void
  disabled?: boolean
  placeholder?: string
  maxLength?: number
  /** 单行 input 的 type(如 'email'),多行时忽略。默认 'text'。 */
  type?: string
  className?: string
  /** 无障碍名(字段名 + 「Enter 保存 / Esc 取消」提示,由调用方用 i18n 拼好)。 */
  ariaLabel?: string
  testid?: string
  rows?: number
}

export const InlineEditField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  InlineEditFieldProps
>(
  (
    {
      multiline = false,
      value,
      onChange,
      onKeyDown,
      onBlur,
      disabled,
      placeholder,
      maxLength,
      type = 'text',
      className,
      ariaLabel,
      testid,
      rows = 3,
    },
    ref
  ) => {
    if (multiline) {
      return (
        <textarea
          ref={ref as React.Ref<HTMLTextAreaElement>}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={maxLength}
          className={className}
          aria-label={ariaLabel}
          data-testid={testid}
        />
      )
    }
    return (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        className={className}
        aria-label={ariaLabel}
        data-testid={testid}
      />
    )
  }
)

InlineEditField.displayName = 'InlineEditField'
