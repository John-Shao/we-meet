import { SelectCompat } from '@/primitives/SelectCompat'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/primitives/Dialog'
import { Button, Input } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'

import { ORG_ROLES } from '../api/adminMembers'
import {
  EXPIRY_PRESETS,
  type CreateInviteLinkInput,
} from '../api/adminInviteLinks'

interface Props {
  isOpen: boolean
  departments: { id: string; name: string }[]
  submitting?: boolean
  onSubmit: (input: CreateInviteLinkInput) => void
  onClose: () => void
}

/**
 * 新建一条邀请链接。
 *
 * 「需要审批」默认开,关掉要过一道确认:免审批的链接意味着**谁转发了这个
 * URL 谁就把人加进了通讯录**,而通讯录里是全公司的手机号。有效期是必填且
 * 有上限——一条永不过期的链接泄漏一次就是永久后门。
 */
export const InviteLinkDialog = ({
  isOpen,
  departments,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [department, setDepartment] = useState('')
  const [orgRole, setOrgRole] = useState('member')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [requireApproval, setRequireApproval] = useState(true)
  const [maxUses, setMaxUses] = useState('')

  useEffect(() => {
    if (isOpen) {
      setDepartment('')
      setOrgRole('member')
      setExpiresInDays(7)
      setRequireApproval(true)
      setMaxUses('')
    }
  }, [isOpen])

  const parsedMaxUses = maxUses.trim() === '' ? null : Number(maxUses)
  const maxUsesInvalid =
    parsedMaxUses !== null &&
    (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1)

  const submit = () => {
    if (submitting || maxUsesInvalid) return
    onSubmit({
      department: department || null,
      org_role: orgRole,
      expires_in_days: expiresInDays,
      require_approval: requireApproval,
      max_uses: parsedMaxUses,
    })
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={t('invites.newLink')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.875rem',
          width: 'min(22rem, calc(100vw - 6rem))',
        })}
      >
        <label className={fieldLabel}>
          <span>{t('invites.configDepartment')}</span>
          <SelectCompat
            value={department}
            aria-label={t('invites.configDepartment')}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value="">{t('members.orgLevel')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </SelectCompat>
        </label>

        <label className={fieldLabel}>
          <span>{t('invite.role')}</span>
          <SelectCompat
            value={orgRole}
            aria-label={t('invite.role')}
            onChange={(e) => setOrgRole(e.target.value)}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`, { defaultValue: r })}
              </option>
            ))}
          </SelectCompat>
        </label>

        <label className={fieldLabel}>
          <span>{t('invites.configExpiry')}</span>
          <SelectCompat
            value={expiresInDays}
            aria-label={t('invites.configExpiry')}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
          >
            {EXPIRY_PRESETS.map((d) => (
              <option key={d} value={d}>
                {t('invites.expiryDays', { count: d })}
              </option>
            ))}
          </SelectCompat>
        </label>

        <label className={fieldLabel}>
          <span>{t('invites.configUsesLabel')}</span>
          <Input
            type="number"
            min={1}
            value={maxUses}
            aria-label={t('invites.configUsesLabel')}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder={t('invites.usesPlaceholder')}
          />
          {maxUsesInvalid && (
            <span className={validationErrorCls} role="alert">
              {t('invites.usesInvalid')}
            </span>
          )}
        </label>

        <Checkbox
          size="sm"
          className={checkboxRow}
          isSelected={requireApproval}
          onChange={setRequireApproval}
        >
          {t('invites.requireApproval')}
        </Checkbox>
        {!requireApproval && (
          <p className={warnCls}>{t('invites.noApprovalWarning')}</p>
        )}

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
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={submitting || maxUsesInvalid}
            loading={submitting}
          >
            {t('invites.create')}
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
  textStyle: 'bodyMedium',
  color: 'text.secondary',
})
const checkboxRow = css({
  textStyle: 'bodyMedium',
  color: 'text.secondary',
})
const validationErrorCls = css({
  textStyle: 'bodySmall',
  color: 'status.danger',
})
const warnCls = css({
  textStyle: 'bodySmall',
  color: 'status.danger',
  backgroundColor: 'danger.subtle',
  borderRadius: 'field',
  padding: 'sm md',
  margin: 0,
})
