import { SelectCompat } from '@/primitives/SelectCompat'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css, cx } from '@/styled-system/css'
import { selectChrome } from '@/primitives/selectChrome'
import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Button } from '@/primitives'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'

import { fetchApprovalTemplates, submitApproval } from '../api/fetchApproval'
import type { ApprovalFormField } from '../api/ApiApproval'

interface Props {
  onClose: () => void
  onSubmitted: () => void
  /** Preselect a template (opened from a 发起申请 grid card). */
  initialTemplateId?: string
}

const labelCss = css({
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 'medium',
  color: 'greyscale.700',
  marginBottom: '0.25rem',
})

// 模板下拉、单行输入、多行 textarea 共用同一套边框/圆角/字号,只在高度上分家:
// 单行的钉 control.md(与 selectChrome 同档),多行的由 rows 决定高度。
const fieldBase = {
  width: '100%',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  paddingX: '0.625rem',
  fontSize: '0.875rem',
} as const

// 钉了高就不能再有上下内边距 —— 会把内容盒挤到装不下 21px 的行盒(font: inherit
// 让行高继承成 1.5),文字被上下切掉,详见 primitives/selectChrome 的注释。
const fieldCss = css({ ...fieldBase, height: 'control.md' })
const textareaCss = css({ ...fieldBase, paddingY: '0.5rem' })

export const SubmitApprovalDialog = ({
  onClose,
  onSubmitted,
  initialTemplateId,
}: Props) => {
  const { t } = useTranslation('approval')
  const firstFieldRef = useRef<HTMLButtonElement>(null)
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '')
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['approval', 'templates'],
    queryFn: fetchApprovalTemplates,
    staleTime: 60_000,
  })

  const selected = useMemo(
    () => templates.find((tpl) => tpl.id === templateId),
    [templates, templateId]
  )
  const fields: ApprovalFormField[] = selected?.form_schema?.fields ?? []

  const setField = (key: string, value: string) =>
    setFormData((prev) => ({ ...prev, [key]: value }))

  const missingRequired = fields.some(
    (f) => f.required && !(formData[f.key] ?? '').trim()
  )

  const submit = async () => {
    if (!templateId || missingRequired || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await submitApproval({ template: templateId, form_data: formData })
      onSubmitted()
    } catch (e) {
      setError(apiErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('form.title')}
      initialFocusRef={firstFieldRef}
    >
      <ModalHeader
        title={t('form.title')}
        onClose={onClose}
        closeLabel={t('form.cancel')}
      />
      <ModalBody>
        <div className={css({ marginBottom: '0.875rem' })}>
          <label htmlFor="approval-template" className={labelCss}>
            {t('form.template')}
          </label>
          <SelectCompat
            id="approval-template"
            ref={firstFieldRef}
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value)
              setFormData({})
            }}
            className={cx(fieldCss, selectChrome)}
          >
            <option value="">{t('form.templatePlaceholder')}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
          </SelectCompat>
          {!isLoading && templates.length === 0 && (
            <p
              className={css({
                fontSize: '0.75rem',
                color: 'greyscale.500',
                marginTop: '0.375rem',
              })}
            >
              {t('form.noTemplates')}
            </p>
          )}
        </div>

        {fields.map((field) => (
          <div key={field.key} className={css({ marginBottom: '0.875rem' })}>
            <label htmlFor={`f-${field.key}`} className={labelCss}>
              {field.label}
              {field.required && (
                <span className={css({ color: 'danger.500' })}> *</span>
              )}
            </label>
            {field.type === 'textarea' ? (
              <textarea
                id={`f-${field.key}`}
                rows={3}
                value={formData[field.key] ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                className={textareaCss}
              />
            ) : (
              <input
                id={`f-${field.key}`}
                type={
                  field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : 'text'
                }
                value={formData[field.key] ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                className={fieldCss}
              />
            )}
          </div>
        ))}

        {error && (
          <p
            className={css({
              fontSize: '0.8125rem',
              color: 'danger.600',
              marginBottom: '0.75rem',
            })}
          >
            {t('form.error', { message: error })}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="action" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={submit}
          isDisabled={!templateId || missingRequired || submitting}
          data-testid="approval-submit"
        >
          {t('form.submit')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
