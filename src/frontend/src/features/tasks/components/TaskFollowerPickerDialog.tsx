import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalFooter, ModalHeader } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts'
import { Button } from '@/primitives'

import type { ApiTaskUser } from '../api/ApiTask'

interface Props {
  initial: ApiTaskUser[]
  excludeIds?: Set<string>
  onConfirm: (followers: ApiTaskUser[]) => void
  onClose: () => void
}

const followerLabel = (follower: ApiTaskUser) =>
  follower.full_name || follower.short_name || follower.email || follower.id

/** Task-specific shell around the shared organization-directory multi-picker. */
export const TaskFollowerPickerDialog = ({
  initial,
  excludeIds,
  onConfirm,
  onClose,
}: Props) => {
  const { t } = useTranslation('tasks')
  const [selected, setSelected] = useState<Map<string, string>>(
    () =>
      new Map(initial.map((follower) => [follower.id, followerLabel(follower)]))
  )
  const followersRef = useRef(
    new Map(initial.map((follower) => [follower.id, follower]))
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, label: string, avatarUrl?: string) => {
    if (selected.has(id)) {
      followersRef.current.delete(id)
      setSelected((current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      })
      return
    }
    followersRef.current.set(id, {
      id,
      full_name: label,
      short_name: null,
      avatar_url: avatarUrl || '',
    })
    setSelected((current) => new Map(current).set(id, label))
  }

  const confirm = () => {
    onConfirm(
      [...selected.keys()].map(
        (id) =>
          followersRef.current.get(id) || {
            id,
            full_name: selected.get(id) || id,
            short_name: null,
            avatar_url: '',
          }
      )
    )
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('followers.select')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <ModalHeader
        title={t('followers.select')}
        onClose={onClose}
        closeLabel={t('followers.cancel')}
      />

      <DirectoryMultiPicker
        includeSelf
        selected={selected}
        onToggle={toggle}
        excludeIds={excludeIds}
        searchRef={searchRef}
        searchTestId="task-follower-search"
        testIdPrefix="task-follower-item-"
        labels={{
          searchPlaceholder: t('followers.search'),
          selectedTitle: t('followers.selected', { count: selected.size }),
          loading: t('followers.loading'),
          empty: t('followers.noResults'),
          loadMore: t('followers.loadMore'),
        }}
      />

      <ModalFooter>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('followers.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={confirm}
          data-testid="task-follower-confirm"
        >
          {t('followers.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
