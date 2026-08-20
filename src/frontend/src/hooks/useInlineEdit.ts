import { useRef, useState } from 'react'

import { useInlineEditFocus } from './useInlineEditFocus'

/**
 * 行内编辑的「无按钮」状态机 —— 全站行内编辑统一走这里,不再手搓「取消/保存」。
 *
 * 交互契约(唯一事实来源):
 *   - 单行字段:Enter 保存、Esc 取消、失焦自动保存。
 *   - 多行字段:Enter 换行(不保存)、Esc 取消、失焦自动保存。
 *   - 未改动就失焦/回车:只退出编辑,不触发 onSave。
 *   - 校验不过:显示 error、重新聚焦、留在编辑态,不丢草稿。
 *   - 保存失败:调用 onSaveError 并留在编辑态(草稿还在,可改后重试)。
 *
 * 焦点接力交给既有的 `useInlineEditFocus`(进编辑聚焦字段、退出还给 ✎ 按钮),
 * 本 hook 只负责「什么时候进/出、怎么提交/取消」。
 *
 * **为什么要有 `ignoreNextBlur`**:commit/cancel 都会把字段卸载(读态是另一棵子树),
 * 卸载一个正聚焦的元素会让浏览器补发一次 blur。若不去管它,「按 Enter 保存」会在
 * 卸载时被那次 blur 再提交一次,「按 Esc 取消」会被那次 blur 误判成「失焦→保存」。
 * 所以两条退出路径都在 setEditing(false) **之前**置上标记,blur 处理器消费一次即复位。
 * 注意标记必须在真正卸载前才置位 —— 放在 commit 开头会在「保存失败仍留编辑态」时
 * 把标记留着,吞掉用户下一次真正点出去的 blur,让失焦保存失效。
 *
 * 用法(读态由调用方自己渲染,编辑态换成字段):
 * ```tsx
 * const edit = useInlineEdit({ value, onSave, validate, multiline })
 * // 读态:<button ref={edit.triggerRef} onClick={edit.startEdit}>✎</button>
 * // 编辑态:<InlineEditField ref={edit.fieldRef} value={edit.draft}
 * //          onChange={edit.onDraftChange} onKeyDown={edit.onFieldKeyDown}
 * //          onBlur={edit.onFieldBlur} disabled={edit.busy} … />
 * ```
 */
export interface UseInlineEditOptions {
  /** 当前已提交的值(读态显示的就是它;进入编辑时作为草稿初始值)。 */
  value: string
  /** 提交动作。调用方自行 trim/判空/相等;返回 resolve 即退出编辑态。 */
  onSave: (draft: string) => Promise<void>
  /** 返回 '' 表示合法,否则返回要内联展示的错误文案。 */
  validate?: (draft: string) => string
  /** true 时渲染多行字段(Enter 换行而非保存)。 */
  multiline?: boolean
  /** onSave 抛错时,返回要内联展示的文案(账号管理的用户名/邮箱用它);不传则不上屏。 */
  formatError?: (error: unknown) => string
  /** onSave 抛错时的旁路回调(群面板用它弹 alert);编辑态保持。与 formatError 互斥与否均可。 */
  onSaveError?: (error: unknown) => void
}

export const useInlineEdit = ({
  value,
  onSave,
  validate,
  multiline = false,
  formatError,
  onSaveError,
}: UseInlineEditOptions) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  // 「用户是否真的敲过键盘」与「draft 是否等于 value」是两码事:value 可能在编辑
  // 期间被外部更新(群昵称的 roster、群名被同步等),此时 draft 仍是旧值、不等于新
  // value,但用户什么都没改,回车/失焦应当直接退出而不是误触发一次保存。所以用
  // dirty 记录「用户有输入」,而不是拿 draft 去比对 value。
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const { fieldRef, triggerRef } = useInlineEditFocus<
    HTMLInputElement | HTMLTextAreaElement
  >(editing)

  // 吞掉「退出编辑态导致字段卸载」的那一次 blur(见文件头注释)。
  const ignoreNextBlur = useRef(false)

  const startEdit = () => {
    setDraft(value)
    setDirty(false)
    setError('')
    ignoreNextBlur.current = false
    setEditing(true)
  }

  const onDraftChange = (next: string) => {
    setDraft(next)
    setDirty(true)
  }

  const commit = () => {
    if (busy) return
    if (!dirty || draft === value) {
      // 没改过(或改完又改回原值):只退出编辑,不发请求,也不报错。
      ignoreNextBlur.current = true
      setEditing(false)
      return
    }
    const validationError = validate?.(draft) ?? ''
    if (validationError) {
      setError(validationError)
      // 失焦自动保存撞上校验失败:把焦点拉回来留在编辑态,草稿不丢。
      fieldRef.current?.focus()
      return
    }
    setBusy(true)
    setError('')
    void (async () => {
      try {
        await onSave(draft)
        // 卸载前一刻才置位 —— 保存失败留在编辑态时不能把标记留着。
        ignoreNextBlur.current = true
        setEditing(false)
      } catch (e) {
        const message = formatError?.(e)
        if (message) setError(message)
        onSaveError?.(e)
      } finally {
        setBusy(false)
      }
    })()
  }

  const cancel = () => {
    ignoreNextBlur.current = true
    setError('')
    setEditing(false)
  }

  // 收窄成最小结构类型(而非具体 KeyboardEvent 泛型):这样同一个处理器既能挂到
  // input 也能挂到 textarea,不必在字段里做 `HTMLInputElement | HTMLTextAreaElement`
  // 的逆变强转 —— 见 InlineEditField 的注释。
  const onFieldKeyDown = (e: { key: string; stopPropagation: () => void }) => {
    if (e.key === 'Escape') {
      // 面板/弹窗在 document 上也挂了 Esc:取消编辑不能顺手把整个容器关掉。
      e.stopPropagation()
      cancel()
      return
    }
    if (!multiline && e.key === 'Enter') {
      commit()
    }
  }

  const onFieldBlur = () => {
    if (ignoreNextBlur.current) {
      ignoreNextBlur.current = false
      return
    }
    commit()
  }

  return {
    editing,
    draft,
    onDraftChange,
    busy,
    error,
    fieldRef,
    triggerRef,
    startEdit,
    commit,
    cancel,
    onFieldKeyDown,
    onFieldBlur,
  }
}
