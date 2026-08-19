import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import { type PermissionEntry, createAdminRole } from '../api/adminRoles'
import { describeApiError } from '../api/errors'

interface Props {
  isOpen: boolean
  /** 已排掉 owner_only —— 那些权限服务端拒绝放进任何自定义角色。 */
  grantable: PermissionEntry[]
  onDone: () => void
  onClose: () => void
}

/** `code` 创建后不可改,所以在这里就限制成 slug,免得存进去才发现改不了。 */
const CODE_PATTERN = /^[a-z][a-z0-9_-]*$/

export const RoleCreateDialog = ({
  isOpen,
  grantable,
  onDone,
  onClose,
}: Props) => {
  const { t } = useTranslation('admin')
  const { alert: showAlert } = useConfirm()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (isOpen) {
      setName('')
      setCode('')
      setPicked(new Set())
    }
  }, [isOpen])

  const createMut = useMutation({
    mutationFn: () =>
      createAdminRole({ name: name.trim(), code, permissions: [...picked] }),
    onSuccess: onDone,
    onError: (e: unknown) => showAlert({ message: describeApiError(e) }),
  })

  const codeValid = CODE_PATTERN.test(code)
  const canSubmit = name.trim().length > 0 && codeValid && !createMut.isPending

  const toggle = (permission: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(permission)) next.delete(permission)
      else next.add(permission)
      return next
    })
  }

  return (
    // type="flex":默认 dialog 档定宽 30rem,36rem 的内容会整片溢到框外。
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      type="flex"
      title={t('roles.createTitle')}
    >
      <div className={css({ width: 'min(36rem, calc(100vw - 6rem))' })}>
        <label className={fieldCls}>
          <span className={labelCls}>{t('roles.nameLabel')}</span>
          {/* eslint-disable jsx-a11y/no-autofocus -- 新建角色的第一步就是填名称。
              RAC 的 useDialog 默认只把焦点放在对话框容器上,必须由子元素 autoFocus
              覆盖 —— 机制由 TextPromptDialog.test.tsx 钉住。 */}
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
          {/* eslint-enable jsx-a11y/no-autofocus */}
        </label>
        <label className={fieldCls}>
          <span className={labelCls}>{t('roles.codeLabel')}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            placeholder="recruiting"
            className={inputCls}
          />
        </label>
        {/* 只在真写了东西之后才提示,免得刚打开就一片红。 */}
        {code.length > 0 && !codeValid && (
          <p className={errorCls}>{t('roles.codeInvalid')}</p>
        )}
        <p className={hintCls}>{t('roles.codeHint')}</p>

        <div className={sectionCls}>{t('roles.permissions')}</div>
        <div className={listCls}>
          {grantable.map((entry) => (
            <label key={entry.code} className={checkRowCls}>
              <input
                type="checkbox"
                checked={picked.has(entry.code)}
                onChange={() => toggle(entry.code)}
              />
              <span className={css({ color: 'greyscale.900' })}>
                {entry.label}
              </span>
              <code className={codeCls}>{entry.code}</code>
            </label>
          ))}
        </div>

        <div className={footerCls}>
          <Button variant="tertiaryText" size="sm" onPress={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isDisabled={!canSubmit}
            onPress={() => createMut.mutate()}
          >
            {t('actions.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const fieldCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  marginBottom: '0.5rem',
})
const labelCls = css({
  width: '5rem',
  flexShrink: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
// 与 admin 其它弹窗的单行输入同档(MemberEditPanel / OffboardDialog 已是
// control.md);钉高必须同时去掉上下内边距,见 primitives/selectChrome 的注释。
const inputCls = css({
  flex: 1,
  height: 'control.md',
  paddingX: '0.5rem',
  border: '1px solid token(colors.control.border)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.875rem',
})
const errorCls = css({
  marginLeft: '5.75rem',
  fontSize: '0.75rem',
  color: 'danger.subtle-text',
})
const hintCls = css({
  marginLeft: '5.75rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const sectionCls = css({
  marginTop: '1rem',
  marginBottom: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 'bold',
  color: 'greyscale.800',
})
const listCls = css({
  maxHeight: '16rem',
  overflowY: 'auto',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
  padding: '0.5rem',
})
const checkRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingY: '0.25rem',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})
const codeCls = css({
  fontFamily: 'monospace',
  fontSize: '0.6875rem',
  color: 'greyscale.400',
})
const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.75rem',
})
