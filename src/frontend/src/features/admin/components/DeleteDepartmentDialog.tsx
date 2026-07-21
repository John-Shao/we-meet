import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'

import type { AdminDepartment } from '../api/adminDepartments'

interface Props {
  isOpen: boolean
  department: AdminDepartment | null
  /** Other departments the members can be reassigned to (excludes the target). */
  candidates: AdminDepartment[]
  submitting?: boolean
  onConfirm: (reassignToId: string | null) => void
  onClose: () => void
}

/**
 * Soft-delete confirmation for a department. The admin picks where its members
 * go: organization-level (no department, the default) or another department —
 * mirrors the backend `?reassign=` behaviour in `admin_org.py`.
 */
export const DeleteDepartmentDialog = ({
  isOpen,
  department,
  candidates,
  submitting,
  onConfirm,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  // '' = organization-level (no department).
  const [reassignTo, setReassignTo] = useState('')

  useEffect(() => {
    if (isOpen) setReassignTo('')
  }, [isOpen])

  return (
    <Dialog
      isOpen={isOpen}
      title={t('org.deleteTitle')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <p
        className={css({
          marginBottom: '1rem',
          color: 'greyscale.700',
          fontSize: '0.9375rem',
          maxWidth: '24rem',
        })}
      >
        {t('org.deleteConfirm', { name: department?.name ?? '' })}
      </p>
      <label
        className={css({
          display: 'block',
          marginBottom: '1.25rem',
          fontSize: '0.875rem',
          color: 'greyscale.700',
        })}
      >
        <span className={css({ display: 'block', marginBottom: '0.375rem' })}>
          {t('org.reassignLabel')}
        </span>
        <select
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
          className={cx(
            selectChrome,
            css({
            width: '100%',
            padding: '0.375rem 0.5rem',
            border: '1px solid token(colors.control.border)',
            borderRadius: '4px',
            backgroundColor: 'greyscale.000',
            color: 'default.text',
            fontSize: '0.875rem',
            })
          )}
        >
          <option value="">{t('org.reassignToOrg')}</option>
          {candidates.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <div
        className={css({
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.5rem',
        })}
      >
        <Button variant="secondary" size="sm" onPress={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          isDisabled={submitting}
          loading={submitting}
          onPress={() => onConfirm(reassignTo || null)}
        >
          {t('actions.delete')}
        </Button>
      </div>
    </Dialog>
  )
}
