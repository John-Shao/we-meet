import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { DirectoryMultiPicker } from '@/features/contacts'

interface Props {
  /** 打开时的已选参与者(id → 名字);对话框内改的是副本。 */
  initial: Map<string, string>
  /** 点「确定」时回传最终结果(附头像,给已选行渲染用);取消则原样不动。 */
  onConfirm: (
    selected: Map<string, string>,
    avatars: Map<string, string>
  ) => void
  onClose: () => void
  /** Optional copy makes the shared directory picker usable for calendar ACLs. */
  title?: string
  searchPlaceholder?: string
  selectedTitle?: (count: number) => string
  confirmLabel?: string
  /** Hide people who are already present in the target collection. */
  excludeIds?: Set<string>
}

/**
 * 批量添加参与者(对标飞书日程的「+ 批量添加」)。
 *
 * 复用 IM「新建群聊」那块左搜索勾选 + 右已选面板([DirectoryMultiPicker]):
 * 一次勾一串人再确定,补齐搜索框「一次一个」够不着的场景。
 *
 * 选择在本地副本上改,确定才回写 —— 中途取消不该动已经选好的人。
 */
export const BulkAttendeeDialog = ({
  initial,
  onConfirm,
  onClose,
  title,
  searchPlaceholder,
  selectedTitle,
  confirmLabel,
  excludeIds,
}: Props) => {
  const { t } = useTranslation('calendar')
  const dialogTitle = title ?? t('form.bulkAddTitle')
  const [draft, setDraft] = useState<Map<string, string>>(
    () => new Map(initial)
  )
  const searchRef = useRef<HTMLInputElement>(null)

  // 勾选那刻把头像记下来:回传给调用方渲染已选行,否则只能退成字母色块。
  const avatarsRef = useRef(new Map<string, string>())

  const toggle = (id: string, label: string, avatarUrl?: string) => {
    if (avatarUrl) avatarsRef.current.set(id, avatarUrl)
    setDraft((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={dialogTitle}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <ModalHeader
        title={dialogTitle}
        onClose={onClose}
        closeLabel={t('form.cancel')}
      />

      <DirectoryMultiPicker
        selected={draft}
        onToggle={toggle}
        labels={{
          searchPlaceholder: searchPlaceholder ?? t('form.searchPlaceholder'),
          selectedTitle:
            selectedTitle?.(draft.size) ??
            t('form.selected', { count: draft.size }),
          loading: t('form.loading'),
          empty: t('form.noResults'),
          loadMore: t('form.loadMore'),
        }}
        searchRef={searchRef}
        searchTestId="bulk-attendee-search"
        testIdPrefix="bulk-attendee-item-"
        includeExternal
        externalLabel={t('form.externalContact')}
        excludeIds={excludeIds}
      />

      <div className={footerCls}>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={() => onConfirm(draft, avatarsRef.current)}
          data-testid="bulk-attendee-confirm"
        >
          {confirmLabel ?? t('form.confirm')}
        </Button>
      </div>
    </Modal>
  )
}

const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
