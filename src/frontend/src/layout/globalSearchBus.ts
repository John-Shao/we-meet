/**
 * 从外部请求打开全局搜索面板。
 *
 * 现在的调用方是云文档:它被 meet 内嵌后,自带的搜索入口已经收敛掉,点搜索按钮 /
 * 按 Ctrl+K 会 postMessage 过来,由 `features/docs/DocsFrame.tsx` 转成这次调用。
 * 快捷键归谁由焦点在哪决定 —— 人在 iframe 里打字时 keydown 只到 iframe,外层
 * 监听不到,所以必须由 docs 转发。
 *
 * 走 window 事件而不是加一个 store:面板开合是纯粹的局部 UI 状态,只为一个跨
 * iframe 的触发就把它提升成全局状态,是拿架构换一次调用。
 *
 * 单独成文件而不是挂在 GlobalSearch.tsx 里,是因为那个文件只该导出组件
 * (react-refresh 的 only-export-components:混着导出常量会让 HMR 整块失效)。
 */

/**
 * 搜索面板的分类标签(对标飞书:单一全局面板 + 分类标签,各模块不单设搜索框)。
 * 新增可搜内容时在这里加一档。
 */
export type SearchCategory =
  | 'all'
  | 'contacts'
  | 'meetings'
  | 'messages'
  | 'docs'
  | 'ai'

const OPEN_EVENT = 'we-meet:open-global-search'

export interface GlobalSearchOpenDetail {
  category?: SearchCategory
}

export const openGlobalSearch = (category?: SearchCategory): void => {
  window.dispatchEvent(
    new CustomEvent<GlobalSearchOpenDetail>(OPEN_EVENT, {
      detail: { category },
    })
  )
}

export const subscribeGlobalSearchOpen = (
  handler: (detail: GlobalSearchOpenDetail) => void
): (() => void) => {
  const onEvent = (e: Event) => {
    handler((e as CustomEvent<GlobalSearchOpenDetail>).detail ?? {})
  }
  window.addEventListener(OPEN_EVENT, onEvent)
  return () => window.removeEventListener(OPEN_EVENT, onEvent)
}
