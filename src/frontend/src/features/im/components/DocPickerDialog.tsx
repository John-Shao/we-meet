import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { RiFileTextLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'

import { fetchMyDocuments, type MyDocumentHit } from '../api/fetchMyDocuments'

interface Props {
  /** Confirm sharing the selected documents into the current conversation. */
  onConfirm: (docs: MyDocumentHit[]) => void
  onClose: () => void
}

/**
 * 分享云文档到聊天(入口 A):聊天输入框「+」→「云文档」弹出的文档选择器。
 * 布局参照 ForwardDialog(搜索 + 多选 + 已选计数 + 发送),数据源为"我的
 * 文档"代理接口——空搜索即最近文档,和 GlobalSearch 的文档搜索同一后端口径。
 */
export const DocPickerDialog = ({ onConfirm, onClose }: Props) => {
  const { t } = useTranslation('im')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Map<string, MyDocumentHit>>(
    new Map()
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const {
    data: docs = [],
    isFetching,
    isError,
  } = useQuery({
    queryKey: ['docs', 'my-documents', query],
    queryFn: () => fetchMyDocuments(query),
    staleTime: 15_000,
    retry: false,
  })

  const toggle = (doc: MyDocumentHit) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(doc.id)) next.delete(doc.id)
      else next.set(doc.id, doc)
      return next
    })

  const selectedList = useMemo(() => [...selected.values()], [selected])

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('docPicker.title')}
      initialFocusRef={searchRef}
      maxWidth="420px"
    >
      <div className={headerCls}>
        <h2 className={titleCls}>{t('docPicker.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.cancel')}
          className={closeCls}
        >
          ×
        </button>
      </div>

      <div className={css({ padding: '0.5rem 1rem' })}>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('docPicker.search')}
          data-testid="doc-picker-search"
          className={inputCls}
        />
      </div>

      <div className={css({ overflowY: 'auto', flex: 1, minHeight: '8rem' })}>
        {isError ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('docPicker.error')}
          </p>
        ) : docs.length === 0 && !isFetching ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('docPicker.empty')}
          </p>
        ) : (
          docs.map((d) => {
            const active = selected.has(d.id)
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => toggle(d)}
                aria-pressed={active}
                data-testid={`doc-picker-item-${d.id}`}
                className={rowCls(active)}
              >
                <span className={checkboxCls(active)} aria-hidden="true">
                  {active ? '✓' : ''}
                </span>
                <RiFileTextLine
                  size={20}
                  className={css({ flexShrink: 0, color: 'primary.600' })}
                />
                <span className={nameCls}>{d.title || '—'}</span>
              </button>
            )
          })
        )}
      </div>

      <div className={footerCls}>
        <span className={selectedCountCls}>
          {t('docPicker.selected', { count: selectedList.length })}
        </span>
        <button
          type="button"
          disabled={selectedList.length === 0}
          onClick={() => selectedList.length > 0 && onConfirm(selectedList)}
          data-testid="doc-picker-send"
          className={sendCls(selectedList.length > 0)}
        >
          {t('docPicker.send', { count: selectedList.length })}
        </button>
      </div>
    </Modal>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const titleCls = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

const closeCls = css({
  border: 'none',
  background: 'transparent',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
})

const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
})

const rowCls = (active: boolean) =>
  css({
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    width: '100%',
    paddingX: '1rem',
    paddingY: '0.5rem',
    border: 'none',
    borderBottom: '1px solid token(colors.greyscale.100)',
    backgroundColor: active ? 'greyscale.100' : 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.100' },
  })

const checkboxCls = (active: boolean) =>
  css({
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.25rem',
    height: '1.25rem',
    borderRadius: '999px',
    border: '1.5px solid',
    borderColor: active ? 'primary.500' : 'greyscale.400',
    backgroundColor: active ? 'primary.500' : 'transparent',
    color: 'white',
    fontSize: '0.75rem',
    lineHeight: 1,
  })

const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const footerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})

const selectedCountCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.500',
})

const sendCls = (enabled: boolean) =>
  css({
    paddingX: '1.25rem',
    paddingY: '0.5rem',
    border: 'none',
    borderRadius: '0.5rem',
    backgroundColor: enabled ? 'primary.500' : 'greyscale.300',
    color: 'white',
    fontSize: '0.875rem',
    fontWeight: 'medium',
    cursor: enabled ? 'pointer' : 'not-allowed',
  })
