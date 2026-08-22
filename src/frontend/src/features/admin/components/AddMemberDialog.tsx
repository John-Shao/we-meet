import { SelectCompat } from '@/primitives/SelectCompat'
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

/** 11 digits, `1` then 3–9 — the same rule the backend enforces. */
const CN_MOBILE = /^1[3-9]\d{9}$/
const digitsOnly = (value: string) =>
  value.replace(/[\s\-()（）.]/g, '').replace(/^\+?86/, '')

/**
 * 添加成员 —— 定向录入一个人（手机号为主键），落成一条待接受的邀请。
 *
 * 这个弹窗此前只收邮箱（P10 M1），而生产上每个人的邮箱都是手机号合成的
 * `<手机号>@phone.we-meet.online`,管理员根本不知道该填什么 —— 功能上线了
 * 但没法用。手机号才是 we-meet 的登录主键（Keycloak 按 phoneNumber 属性
 * 查号建号）,所以这里把它提为必填,邮箱降为可选补充。
 *
 * 与飞书一致:只校验格式与本企业内不重复,**不预先检测这个号有没有注册过**
 * —— 从这里根本查不到（Keycloak 是首次 OTP 时才建号）,装作查得到只会是
 * 一个带 loading 的谎。人真正进通讯录是在他首次登录之后。
 */
export const AddMemberDialog = ({
  isOpen,
  departments,
  submitting,
  onSubmit,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [department, setDepartment] = useState('')
  const [orgRole, setOrgRole] = useState<string>('member')
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (isOpen) {
      setFullName('')
      setPhone('')
      setEmail('')
      setDepartment('')
      setOrgRole('member')
      setTitle('')
    }
  }, [isOpen])

  const normalizedPhone = digitsOnly(phone)
  // Only complain once there is something to complain about — a red field on
  // an empty form that has not been touched is noise.
  const phoneInvalid =
    normalizedPhone.length > 0 && !CN_MOBILE.test(normalizedPhone)
  const canSubmit = CN_MOBILE.test(normalizedPhone) && !submitting

  const submit = () => {
    if (!canSubmit) return
    onSubmit({
      phone: normalizedPhone,
      email: email.trim() || undefined,
      full_name: fullName.trim(),
      department: department || null,
      org_role: orgRole,
      title: title.trim(),
    })
  }

  return (
    <Dialog
      isOpen={isOpen}
      title={t('addMember.title')}
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
          minWidth: '22rem',
        })}
      >
        <label className={fieldLabel}>
          <span>{t('addMember.phone')}</span>
          {/* eslint-disable jsx-a11y/no-autofocus -- 手机号是这个对话框的主键字段
              (必填),打开就该能直接输。RAC useDialog 默认只聚焦容器,需子元素
              autoFocus 覆盖(机制见 TextPromptDialog.test.tsx)。 */}
          <Input
            autoFocus
            type="tel"
            inputMode="numeric"
            value={phone}
            required
            onChange={(e) => setPhone(e.target.value)}
            placeholder="13800000000"
          />
          {/* eslint-enable jsx-a11y/no-autofocus */}
          {phoneInvalid && (
            <span className={css({ fontSize: '0.75rem', color: 'danger.600' })}>
              {t('addMember.phoneInvalid')}
            </span>
          )}
        </label>
        <label className={fieldLabel}>
          <span>{t('addMember.name')}</span>
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </label>
        <label className={fieldLabel}>
          <span>{t('addMember.email')}</span>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <label className={fieldLabel}>
          <span>{t('invite.department')}</span>
          <SelectCompat
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className={selectCss}
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
            onChange={(e) => setOrgRole(e.target.value)}
            className={selectCss}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`, { defaultValue: r })}
              </option>
            ))}
          </SelectCompat>
        </label>
        <label className={fieldLabel}>
          <span>{t('invite.jobTitle')}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p
          className={css({
            fontSize: '0.75rem',
            color: 'greyscale.500',
            margin: 0,
          })}
        >
          {t('addMember.hint')}
        </p>
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
            isDisabled={!canSubmit}
            loading={submitting}
          >
            {t('addMember.submit')}
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
