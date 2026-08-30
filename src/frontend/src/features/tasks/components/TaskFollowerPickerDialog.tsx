import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

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
      <div className={headerCss}>
        <h2 className={titleCss}>{t('followers.select')}</h2>
        <ModalCloseButton onClose={onClose} label={t('followers.cancel')} />
      </div>

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

      <div className={footerCss}>
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
      </div>
    </Modal>
  )
}

const headerCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const titleCss = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

const footerCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
