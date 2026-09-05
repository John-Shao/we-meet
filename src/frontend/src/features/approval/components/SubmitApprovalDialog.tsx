import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { StateHint } from '@/components/StateHint'
import { Button, Input, TextArea } from '@/primitives'
import { Dialog } from '@/primitives/Dialog'
import { SelectCompat } from '@/primitives/SelectCompat'
import { css } from '@/styled-system/css'

import type { ApprovalFormField } from '../api/ApiApproval'
import { fetchApprovalTemplates, submitApproval } from '../api/fetchApproval'

interface Props {
  onClose: () => void
  onSubmitted: () => void
  /** Preselect a template when opened from a request-type card. */
  initialTemplateId?: string
}

export const SubmitApprovalDialog = ({
  onClose,
  onSubmitted,
  initialTemplateId,
}: Props) => {
  const { t } = useTranslation('approval')
  const { t: tAdmin } = useTranslation('admin')
  const firstFieldRef = useRef<HTMLButtonElement>(null)
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '')
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const {
    data: templates = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['approval', 'templates'],
    queryFn: fetchApprovalTemplates,
    staleTime: 60_000,
  })

  const selected = useMemo(
    () => templates.find((template) => template.id === templateId),
    [templates, templateId]
  )
  const fields: ApprovalFormField[] = selected?.form_schema?.fields ?? []

  useEffect(() => {
    if (isLoading || isError) return
    const frame = requestAnimationFrame(() => firstFieldRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [isError, isLoading])

  const setField = (key: string, value: string) =>
    setFormData((previous) => ({ ...previous, [key]: value }))

  const missingRequired = fields.some(
    (field) => field.required && !(formData[field.key] ?? '').trim()
  )

  const submit = async () => {
    if (!templateId || missingRequired || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await submitApproval({ template: templateId, form_data: formData })
      onSubmitted()
    } catch (cause) {
      setError(apiErrorMessage(cause))
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      isOpen
      title={t('form.title')}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div className={contentCss}>
        {isLoading ? (
          <StateHint className={stateCss} state="loading">
            {t('page.loading')}
          </StateHint>
        ) : isError ? (
          <StateHint
            className={stateCss}
            state="error"
            action={
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void refetch()}
              >
                {tAdmin('feedback.retry')}
              </Button>
            }
          >
            {tAdmin('feedback.loadFailed')}
          </StateHint>
        ) : (
          <>
            <div className={fieldGroupCss}>
              <label htmlFor="approval-template" className={labelCss}>
                {t('form.template')}
              </label>
              <SelectCompat
                id="approval-template"
                ref={firstFieldRef}
                value={templateId}
                aria-label={t('form.template')}
                onChange={(event) => {
                  setTemplateId(event.target.value)
                  setFormData({})
                }}
              >
                <option value="">{t('form.templatePlaceholder')}</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </SelectCompat>
              {templates.length === 0 ? (
                <p className={emptyCss}>{t('form.noTemplates')}</p>
              ) : null}
            </div>

            {fields.map((field) => (
              <div key={field.key} className={fieldGroupCss}>
                <label htmlFor={`f-${field.key}`} className={labelCss}>
                  {field.label}
                  {field.required ? (
                    <span className={requiredCss}> *</span>
                  ) : null}
                </label>
                {field.type === 'textarea' ? (
                  <TextArea
                    id={`f-${field.key}`}
                    rows={3}
                    required={field.required}
                    value={formData[field.key] ?? ''}
                    onChange={(event) =>
                      setField(field.key, event.target.value)
                    }
                    className={textareaCss}
                  />
                ) : (
                  <Input
                    id={`f-${field.key}`}
                    type={
                      field.type === 'number'
                        ? 'number'
                        : field.type === 'date'
                          ? 'date'
                          : 'text'
                    }
                    required={field.required}
                    value={formData[field.key] ?? ''}
                    onChange={(event) =>
                      setField(field.key, event.target.value)
                    }
                  />
                )}
              </div>
            ))}

            {error ? (
              <p className={errorCss} role="alert">
                {t('form.error', { message: error })}
              </p>
            ) : null}
          </>
        )}

        <div className={footerCss}>
          <Button variant="secondary" size="sm" onPress={onClose}>
            {t('form.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onPress={submit}
            isDisabled={
              isLoading ||
              isError ||
              !templateId ||
              missingRequired ||
              submitting
            }
            loading={submitting}
            data-testid="approval-submit"
          >
            {t('form.submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const contentCss = css({ width: 'min(27rem, calc(100vw - 6rem))' })
const stateCss = css({ padding: 'lg' })
const fieldGroupCss = css({ marginBottom: 'lg' })
const labelCss = css({
  display: 'block',
  marginBottom: 'xs',
  textStyle: 'bodySmall',
  fontWeight: 'medium',
  color: 'text.secondary',
})
const emptyCss = css({
  marginTop: 'sm',
  textStyle: 'bodySmall',
  color: 'text.secondary',
})
const requiredCss = css({ color: 'status.danger' })
const textareaCss = css({ minHeight: '5rem', resize: 'vertical' })
const errorCss = css({
  marginBottom: 'md',
  textStyle: 'bodySmall',
  color: 'status.danger',
})
const footerCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 'sm',
  marginTop: 'lg',
})
