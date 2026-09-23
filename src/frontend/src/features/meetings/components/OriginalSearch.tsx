import { useTranslation } from 'react-i18next'
import { SearchBox } from '@/primitives'
import { css } from '@/styled-system/css'

/**
 * 逐字稿内的搜索框。
 *
 * 与列表页（收口记录 §3.13）同一口径：
 *   - 结构走共享 `SearchBox`（放大镜 + 清空 + `type="search"`），不再手写 input；
 *   - **没有「搜索」按钮** —— 提交只剩回车（`onSubmit`），清空输入立刻撤销关键词筛选。
 *     `SearchBox` 的 ✕ 是清空不是提交（基元里写了 `type="button"`），两者不会互相干扰。
 *
 * 命中词的高亮不在这里：它由 `TranscriptSegment` 的 `highlight` 负责 —— 那个词要落在
 * 正文里（对齐参考稿：命中处是浅蓝底），搜索框本身只负责取值。
 */
export function OriginalSearch({
  onSearch,
  value,
  onChange,
}: {
  onSearch: (query: string) => void
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('meetings')
  return (
    <form
      role="search"
      className={css({
        display: 'flex',
        gap: 'sm',
        flexWrap: 'wrap',
        marginY: 'md',
        marginX: 0,
        alignItems: 'center',
      })}
      onSubmit={(event) => {
        event.preventDefault()
        onSearch(value.trim())
      }}
    >
      <SearchBox
        maxLength={200}
        value={value}
        onChange={(value) => {
          onChange(value)
          // 清空即撤销：与列表页一样，不必再点一次「搜索」。
          if (!value) onSearch('')
        }}
        placeholder={t('library.searchOriginal')}
        className={css({ flex: '1 1 12rem', minWidth: 0, maxWidth: '100%' })}
      />
    </form>
  )
}
