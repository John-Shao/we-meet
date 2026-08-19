import { useEffect, useRef } from 'react'

/**
 * 行内编辑的焦点接力:进入编辑态把焦点交给字段,退出编辑态把焦点还给触发它的那个
 * 按钮。
 *
 * 解决的是一类反复出现的小毛病:点了「编辑」却还得再点一下输入框才能打字;以及它
 * 的反面 —— 输入框一卸载,焦点掉到 `<body>`,键盘用户下一次 Tab 得从页面/对话框
 * 头部重新走一遍。
 *
 * **为什么不用 `useRestoreFocus`**:那个 hook 在**开启瞬间**记下
 * `document.activeElement`,关闭时再 focus 回去,并用 `document.contains(trigger)`
 * 守卫。行内编辑不满足它的前提 —— 读态与编辑态是两棵不同的子树,「编辑」按钮在编辑
 * 期间被整段卸载,退出时挂载的是一个**新**节点,旧节点已不在文档里,那个守卫会直接
 * 跳过恢复。所以这里改成「ref 指向当下挂载的那个节点」。
 * 分工:面板/菜单开关(触发器始终在 DOM 里)用 `useRestoreFocus`;触发器本身会被
 * 替换掉的行内编辑用本 hook。
 *
 * **为什么要记住上一次的状态**:首屏 `active` 本来就是 false,不能在挂载时就把焦点
 * 抢到触发按钮上 —— 那会和对话框自己的初始焦点(见 `components/Modal` 的
 * `initialFocusRef`)打架。所以只认 true→false 这一次跳变。
 *
 * 用法:
 * ```tsx
 * const { fieldRef, triggerRef } = useInlineEditFocus(editing)
 * // 读态:   <button ref={triggerRef} onClick={() => setEditing(true)}>编辑</button>
 * // 编辑态: <input ref={fieldRef} value={draft} … />
 * ```
 * 两个 ref 都可以只挂其中一个:只需要「进编辑聚焦」时不挂 `triggerRef` 即可,
 * 缺失的那个 ref 是 null,hook 什么也不做。多行字段传
 * `useInlineEditFocus<HTMLTextAreaElement>(editing)`。
 */
export const useInlineEditFocus = <
  Field extends HTMLElement = HTMLInputElement,
  Trigger extends HTMLElement = HTMLButtonElement,
>(
  active: boolean
) => {
  const fieldRef = useRef<Field>(null)
  const triggerRef = useRef<Trigger>(null)
  const wasActive = useRef(false)

  useEffect(() => {
    if (active) {
      // 字段这一侧**允许**滚动:它是用户此刻的目标,必须可见。长表单里字段本来就
      // 在刚点过的那一行,通常不会真的滚。
      fieldRef.current?.focus()
    } else if (wasActive.current) {
      // 回到触发器这一侧则压掉滚动:人可能在编辑期间滚到了别处,把页面拽回按钮那里
      // 会像"跳了一下"(同 useRestoreFocus 的 preventScroll 取舍)。
      triggerRef.current?.focus({ preventScroll: true })
    }
    wasActive.current = active
  }, [active])

  return { fieldRef, triggerRef }
}
