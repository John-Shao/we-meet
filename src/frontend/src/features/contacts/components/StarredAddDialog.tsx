import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'

import { DirectoryMultiPicker } from './DirectoryMultiPicker'
import { setContactPref } from '../api/setContactPref'

interface Props {
  /** 已经是星标的人 —— 从候选里排掉,避免「添加」了个已有的。 */
  alreadyStarredIds: Set<string>
  /** 至少成功打上一个星标后回调(调用方据此刷新列表并关窗)。 */
  onDone: () => void
  onClose: () => void
  /** 出错时提示(调用方通常传 ConfirmProvider 的 alert)。 */
  onError: (message: string) => void
}

/**
 * 「添加星标联系人」(对标飞书星标列表页右上角的「添加」)。
 *
 * 复用通讯录那块左搜索勾选 + 右已选面板([DirectoryMultiPicker]),与日历
 * 「批量添加参与者」同一套交互:一次勾一串人再确定。星标接口本身是幂等的,
 * 所以重复提交不会造成脏数据。
 */
export const StarredAddDialog = ({
  alreadyStarredIds,
  onDone,
  onClose,
  onError,
}: Props) => {
  const { t } = useTranslation('contacts')
  const [draft, setDraft] = useState<Map<string, string>>(() => new Map())
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, label: string) => {
    setDraft((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })
  }

  const confirm = async () => {
    if (draft.size === 0) {
      onClose()
      return
    }
    setBusy(true)
    try {
      // 逐个 POST(名单短,且失败时能明确停在第一个错上,不留半个成功一半未知)。
      for (const id of draft.keys()) {
        // 只发 is_starred:批量加星标不该顺手动别人的「特别提醒」。
        await setContactPref(id, { is_starred: true })
      }
      onDone()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('starred.addTitle')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <ModalHeader
        title={t('starred.addTitle')}
        onClose={onClose}
        closeLabel={t('starred.cancel')}
      />

      <DirectoryMultiPicker
        selected={draft}
        onToggle={toggle}
        excludeIds={alreadyStarredIds}
        labels={{
          searchPlaceholder: t('picker.searchPlaceholder'),
          selectedTitle: t('starred.selected', { count: draft.size }),
          loading: t('picker.loading'),
          empty: t('picker.empty'),
          loadMore: t('picker.loadMore'),
        }}
        searchRef={searchRef}
        searchTestId="starred-add-search"
        testIdPrefix="starred-add-item-"
      />

      <ModalFooter>
        <Button
          variant="secondaryText"
          size="action"
          onPress={onClose}
          isDisabled={busy}
        >
          {t('starred.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={confirm}
          isDisabled={busy}
          data-testid="starred-add-confirm"
        >
          {t('starred.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
