import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { DirectoryMultiPicker } from '@/features/contacts'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskUser } from '../api/ApiTask'

const MAX_ASSIGNEES = 10

interface Props {
  initial: ApiTaskUser[]
  onConfirm: (assignees: ApiTaskUser[]) => void
  onClose: () => void
}

const assigneeLabel = (assignee: ApiTaskUser) =>
  assignee.full_name || assignee.short_name || assignee.email || assignee.id

export const TaskAssigneePickerDialog = ({
  initial,
  onConfirm,
  onClose,
}: Props) => {
  const { t } = useTranslation('tasks')
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map(initial.map((item) => [item.id, assigneeLabel(item)]))
  )
  const assigneesRef = useRef(
    new Map(initial.map((assignee) => [assignee.id, assignee]))
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, label: string, avatarUrl?: string) => {
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(id)) next.delete(id)
      else {
        if (next.size >= MAX_ASSIGNEES) return current
        next.set(id, label)
        assigneesRef.current.set(id, {
          id,
          full_name: label,
          short_name: null,
          avatar_url: avatarUrl || '',
        })
      }
      return next
    })
  }

  const confirm = () => {
    if (selected.size === 0) return
    onConfirm(
      [...selected.keys()].map(
        (id) =>
          assigneesRef.current.get(id) || {
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
      ariaLabel={t('assignees.select')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <div className={headerCss}>
        <div>
          <h2 className={titleCss}>{t('assignees.select')}</h2>
          <p className={hintCss}>{t('assignees.limit')}</p>
        </div>
        <ModalCloseButton onClose={onClose} label={t('followers.cancel')} />
      </div>
      <DirectoryMultiPicker
        includeSelf
        selected={selected}
        onToggle={toggle}
        searchRef={searchRef}
        searchTestId="task-assignee-search"
        testIdPrefix="task-assignee-item-"
        labels={{
          searchPlaceholder: t('form.searchAssignee'),
          selectedTitle: t('assignees.selected', { count: selected.size }),
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
          isDisabled={selected.size === 0}
          data-testid="task-assignee-confirm"
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
const titleCss = css({ margin: 0, fontSize: '1rem', fontWeight: 'bold' })
const hintCss = css({ margin: 0, fontSize: '0.75rem', color: 'greyscale.600' })
const footerCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
