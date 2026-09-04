import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Button, Input } from '@/primitives'
import { Modal, ModalFooter, ModalHeader } from '@/components/Modal'
import { useUser } from '@/features/auth'
import { DirectoryMultiPicker } from '@/features/contacts'

/**
 * Modal directory picker for creating a GROUP conversation (对标飞书):
 * the creator (self) is always selected and locked; other org members are
 * toggled on the left and shown as removable chips on the right. The chosen
 * member ids (excluding self — the backend adds the owner automatically) are
 * passed to `onCreate` along with an optional group name.
 */
interface Props {
  onCreate: (memberUserIds: string[], name: string) => void
  onClose: () => void
  /** Pre-selected members (we-meet user id → label), e.g. the peer when
   * creating a group from a 1-on-1 conversation. */
  initialMembers?: Array<{ id: string; label: string }>
}

export const GroupPicker = ({ onCreate, onClose, initialMembers }: Props) => {
  const { t } = useTranslation('im')
  const { user } = useUser()
  const [name, setName] = useState('')
  // id → display label, captured at toggle time so chips stay labelled even
  // after the search query (and thus the visible member list) changes.
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map((initialMembers ?? []).map((m) => [m.id, m.label]))
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const selfLabel = user?.full_name || user?.email || t('group.you')

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate = selected.size > 0
  // count includes self (locked).
  const total = selected.size + 1

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('group.title')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <ModalHeader
        title={t('group.title')}
        onClose={onClose}
        closeLabel={t('group.cancel')}
      />

      {/* 左搜索勾选 + 右已选 —— 与日历「批量添加参与者」共用同一块面板。 */}
      <DirectoryMultiPicker
        selected={selected}
        onToggle={toggle}
        labels={{
          searchPlaceholder: t('group.searchPlaceholder'),
          selectedTitle: t('group.selected', { count: total }),
          loading: t('group.loading'),
          empty: t('group.empty'),
          loadMore: t('group.loadMore'),
        }}
        locked={{
          label: selfLabel,
          sub: t('group.you'),
          avatarSrc: user?.avatar_url,
        }}
        searchRef={searchRef}
        searchTestId="group-picker-search"
        testIdPrefix="group-picker-item-"
      />

      <ModalFooter>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('group.namePlaceholder')}
          data-testid="group-picker-name"
          className={css({ flex: 1, minWidth: 0 })}
        />
        <Button
          variant="primary"
          size="action"
          isDisabled={!canCreate}
          onPress={() => onCreate([...selected.keys()], name.trim())}
          data-testid="group-picker-create"
          className={css({ flexShrink: 0 })}
        >
          {t('group.create')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
