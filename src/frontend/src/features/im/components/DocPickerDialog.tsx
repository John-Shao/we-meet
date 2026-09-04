import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { RiFileTextLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { Button, Input, SelectableListRow } from '@/primitives'

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
      <ModalHeader
        title={t('docPicker.title')}
        onClose={onClose}
        closeLabel={t('group.cancel')}
      />

      <div className={css({ padding: '0.5rem 1rem' })}>
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('docPicker.search')}
          data-testid="doc-picker-search"
        />
      </div>

      <ModalBody padding="none" minHeight="8rem">
        {isError ? (
          <StateHint state="error">{t('docPicker.error')}</StateHint>
        ) : isFetching && docs.length === 0 ? (
          <StateHint state="loading">{t('group.loading')}</StateHint>
        ) : docs.length === 0 ? (
          <StateHint>{t('docPicker.empty')}</StateHint>
        ) : (
          docs.map((d) => {
            const active = selected.has(d.id)
            return (
              <SelectableListRow
                key={d.id}
                onClick={() => toggle(d)}
                isSelected={active}
                data-testid={`doc-picker-item-${d.id}`}
                divider
              >
                <RiFileTextLine
                  size={20}
                  aria-hidden="true"
                  className={css({ flexShrink: 0, color: 'text.link' })}
                />
                <span className={nameCls}>{d.title || '—'}</span>
              </SelectableListRow>
            )
          })
        )}
      </ModalBody>

      <ModalFooter alignment="space-between">
        <span className={selectedCountCls}>
          {t('docPicker.selected', { count: selectedList.length })}
        </span>
        <Button
          variant="primary"
          size="action"
          isDisabled={selectedList.length === 0}
          onPress={() => selectedList.length > 0 && onConfirm(selectedList)}
          data-testid="doc-picker-send"
        >
          {t('docPicker.send', { count: selectedList.length })}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const selectedCountCls = css({
  textStyle: 'bodySmall',
  color: 'text.secondary',
})
