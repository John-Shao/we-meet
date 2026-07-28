import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts'

import { ghostBtn } from './formStyles'

interface Props {
  /** 打开时的已选参与者(id → 名字);对话框内改的是副本。 */
  initial: Map<string, string>
  /** 点「确定」时回传最终结果(附头像,给已选行渲染用);取消则原样不动。 */
  onConfirm: (
    selected: Map<string, string>,
    avatars: Map<string, string>
  ) => void
  onClose: () => void
}

/**
 * 批量添加参与者(对标飞书日程的「+ 批量添加」)。
 *
 * 复用 IM「新建群聊」那块左搜索勾选 + 右已选面板([DirectoryMultiPicker]):
 * 一次勾一串人再确定,补齐搜索框「一次一个」够不着的场景。
 *
 * 选择在本地副本上改,确定才回写 —— 中途取消不该动已经选好的人。
 */
export const BulkAttendeeDialog = ({ initial, onConfirm, onClose }: Props) => {
  const { t } = useTranslation('calendar')
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
      ariaLabel={t('form.bulkAddTitle')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <div className={headerCls}>
        <h2 className={titleCls}>{t('form.bulkAddTitle')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('form.cancel')}
          className={closeBtnCls}
        >
          ×
        </button>
      </div>

      <DirectoryMultiPicker
        selected={draft}
        onToggle={toggle}
        labels={{
          searchPlaceholder: t('form.searchPlaceholder'),
          selectedTitle: t('form.selected', { count: draft.size }),
          loading: t('form.loading'),
          empty: t('form.noResults'),
        }}
        searchRef={searchRef}
        searchTestId="bulk-attendee-search"
        testIdPrefix="bulk-attendee-item-"
      />

      <div className={footerCls}>
        <button type="button" onClick={onClose} className={ghostBtn}>
          {t('form.cancel')}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(draft, avatarsRef.current)}
          data-testid="bulk-attendee-confirm"
          className={confirmBtnCls}
        >
          {t('form.confirm')}
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

const closeBtnCls = css({
  border: 'none',
  background: 'transparent',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
})

const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})

const confirmBtnCls = css({
  paddingX: '1rem',
  paddingY: '0.5rem',
  border: 'none',
  borderRadius: '0.5rem',
  backgroundColor: 'primary.500',
  color: 'white',
  fontSize: '0.875rem',
  fontWeight: 'medium',
  cursor: 'pointer',
  _dark: { backgroundColor: 'primaryDark.500' },
})
