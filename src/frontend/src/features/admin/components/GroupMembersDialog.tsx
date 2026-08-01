import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'
import { DirectoryMultiPicker } from '@/features/contacts/components/DirectoryMultiPicker'

import { type UserGroup, addUserGroupMembers } from '../api/adminUserGroups'
import { describeApiError } from '../api/errors'

interface Props {
  /** null = closed. */
  group: UserGroup | null
  /** Already in the group — kept out of the candidate list. */
  existingIds: Set<string>
  onDone: () => void
  onClose: () => void
}

/**
 * 把人加进用户组。选人复用通讯录的多选面板(它已经做对了分页——不翻页的话
 * 100 人以后的同事在候选里根本不出现)。
 *
 * 服务端会把「不是本组织在职成员」的 id 挡掉并在响应里报出条数,这里如实转述而
 * 不是显示「已添加 N 人」了事:静默丢弃的话,管理员会以为人加进去了。
 */
export const GroupMembersDialog = ({
  group,
  existingIds,
  onDone,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const { alert: showAlert } = useConfirm()
  const [selected, setSelected] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (group) setSelected(new Map())
  }, [group])

  const addMut = useMutation({
    mutationFn: (ids: string[]) => addUserGroupMembers(group!.id, ids),
    onSuccess: (result) => {
      if (result.skipped > 0) {
        void showAlert({
          message: t('groups.addPartial', {
            added: result.added,
            skipped: result.skipped,
          }),
        })
      }
      onDone()
    },
    onError: (e: unknown) => showAlert({ message: describeApiError(e) }),
  })

  const toggle = (id: string, label: string) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })
  }

  return (
    <Dialog
      isOpen={group !== null}
      onClose={onClose}
      title={t('groups.addMembersTitle', { name: group?.name ?? '' })}
    >
      <div className={css({ width: 'min(44rem, 80vw)' })}>
        <DirectoryMultiPicker
          selected={selected}
          onToggle={toggle}
          excludeIds={existingIds}
          testIdPrefix="group-member-picker-item-"
          labels={{
            searchPlaceholder: t('groups.searchPeople'),
            selectedTitle: t('groups.selectedCount', { count: selected.size }),
            loading: t('groups.loadingPeople'),
            empty: t('groups.noPeople'),
            loadMore: t('actions.loadMore'),
          }}
        />
        <div className={footerCls}>
          <Button variant="tertiaryText" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={selected.size === 0 || addMut.isPending}
            onPress={() => addMut.mutate([...selected.keys()])}
          >
            {t('actions.add')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.75rem',
})
