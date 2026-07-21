import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'

import { ORG_ROLES } from '../api/adminMembers'
import type { CreateInvitationInput } from '../api/adminInvitations'

interface Props {
  isOpen: boolean
  departments: { id: string; name: string }[]
  submitting?: boolean
  onSubmit: (input: CreateInvitationInput) => void
  onClose: () => void
}

/**
 * Invite (pre-provision) a person by email into a department / role / title.
 * The values are applied to their Membership when they first sign in.
 */
export const InviteDialog = ({
  isOpen,
  departments,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [email, setEmail] = useState('')
  const [department, setDepartment] = useState('')
  const [orgRole, setOrgRole] = useState<string>('member')
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (isOpen) {
      setEmail('')
      setDepartment('')
      setOrgRole('member')
      setTitle('')
    }
  }, [isOpen])

  const trimmedEmail = email.trim()
  const submit = () => {
    if (!trimmedEmail || submitting) return
    onSubmit({
      email: trimmedEmail,
      department: department || null,
      org_role: orgRole,
      title: title.trim(),
    })
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={t('invite.title')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className={css({ display: 'flex', flexDirection: 'column', gap: '0.875rem', minWidth: '20rem' })}
      >
        <label className={fieldLabel}>
          <span>{t('invite.email')}</span>
          <Input
            type="email"
            value={email}
            autoFocus
            required
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <label className={fieldLabel}>
          <span>{t('invite.department')}</span>
          <select value={department} onChange={(e) => setDepartment(e.target.value)} className={selectCss}>
            <option value="">{t('members.orgLevel')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLabel}>
          <span>{t('invite.role')}</span>
          <select value={orgRole} onChange={(e) => setOrgRole(e.target.value)} className={selectCss}>
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`, { defaultValue: r })}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldLabel}>
          <span>{t('invite.jobTitle')}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className={css({ fontSize: '0.75rem', color: 'greyscale.500', margin: 0 })}>
          {t('invite.hint')}
        </p>
        <div className={css({ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' })}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={!trimmedEmail || submitting}
            loading={submitting}
          >
            {t('invite.send')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const fieldLabel = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  fontSize: '0.875rem',
  color: 'greyscale.700',
})
const selectCss = cx(
  css({
    width: '100%',
    padding: '0.375rem 0.5rem',
    border: '1px solid token(colors.control.border)',
    borderRadius: '4px',
    backgroundColor: 'greyscale.000',
    color: 'default.text',
    fontSize: '0.875rem',
  }),
  selectChrome
)
