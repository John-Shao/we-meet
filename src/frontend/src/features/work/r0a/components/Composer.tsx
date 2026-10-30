import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
  RiArrowRightLine,
  RiCheckLine,
  RiSparkling2Line,
} from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { TextArea } from '@/primitives/TextArea'
import { css, cx } from '@/styled-system/css'
import type {
  PermissionMode,
  WorkBootstrap,
  WorkPreviewResponse,
  WorkTemplate,
} from '../api/types'
import {
  useCreateWorkInput,
  useCreateWorkPreview,
  useSubmitWorkTask,
  useWorkTemplates,
} from '../api/queries'
import { useIdempotencyKey } from '../hooks/useIdempotencyKey'
import { card, errorText, inputError, label, muted, row } from '../ui'

type Props = { bootstrap: WorkBootstrap }

const choice = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'xxs',
  padding: 'sm',
  minWidth: '8rem',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  backgroundColor: 'surface.default',
  color: 'text.primary',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { borderColor: 'border.strong' },
})

const choiceActive = css({
  borderColor: 'brand.500',
  backgroundColor: 'brand.50',
})

export const Composer = ({ bootstrap }: Props) => {
  const { t } = useTranslation('work')
  const [, navigate] = useLocation()
  const templatesQ = useWorkTemplates()
  const createInput = useCreateWorkInput()
  const createPreview = useCreateWorkPreview()
  const submitTask = useSubmitWorkTask()
  const inputKey = useIdempotencyKey()
  const submitKey = useIdempotencyKey()
  const previewGeneration = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      previewGeneration.current += 1
    }
  }, [])

  const [goal, setGoal] = useState('')
  const [background, setBackground] = useState('')
  const [templateId, setTemplateId] = useState('summary')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    bootstrap.allowed_permission_modes[0] ?? 'ask_each'
  )
  const [preview, setPreview] = useState<WorkPreviewResponse | null>(null)
  const [inputRef, setInputRef] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const templates = useMemo(
    () => templatesQ.data?.items ?? [],
    [templatesQ.data]
  )
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === templateId),
    [templates, templateId]
  )
  const goalLength = Array.from(goal).length
  const backgroundLength = Array.from(background).length
  const busy =
    createInput.isPending || createPreview.isPending || submitTask.isPending
  const invalidGoal =
    !goal.trim() || goalLength > bootstrap.limits.max_goal_chars
  const invalidBackground =
    backgroundLength > bootstrap.limits.max_background_chars

  const resetPreview = (clearInput = false) => {
    previewGeneration.current += 1
    setPreview(null)
    setError(null)
    if (clearInput) {
      setInputRef(null)
      inputKey.rotate()
    }
  }

  const invalidateInput = () => {
    setPreview(null)
    setError(null)
    setInputRef(null)
    previewGeneration.current += 1
    inputKey.rotate()
  }

  const onGoalChange = (value: string) => {
    setGoal(value)
    invalidateInput()
  }

  const onBackgroundChange = (value: string) => {
    setBackground(value)
    invalidateInput()
  }

  const onTemplateChange = (value: string) => {
    setTemplateId(value)
    resetPreview(false)
  }

  const onModeChange = (value: PermissionMode) => {
    setPermissionMode(value)
    resetPreview(false)
  }

  const requestPreview = async () => {
    setError(null)
    if (invalidGoal || invalidBackground) return
    const generation = previewGeneration.current + 1
    previewGeneration.current = generation
    try {
      let currentInput = inputRef
      if (!currentInput) {
        const created = await createInput.mutateAsync({
          client_request_id: inputKey.key,
          goal,
          background,
        })
        if (generation !== previewGeneration.current) return
        currentInput = created.input_ref
        setInputRef(currentInput)
      }
      const previewResult = await createPreview.mutateAsync({
        input_ref: currentInput,
        template_id: templateId,
        permission_mode: permissionMode,
      })
      if (generation !== previewGeneration.current) return
      setPreview(previewResult)
      submitKey.rotate()
    } catch (cause) {
      if (generation === previewGeneration.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  const confirmSubmit = async () => {
    if (!preview) return
    setError(null)
    try {
      const task = await submitTask.mutateAsync({
        client_request_id: submitKey.key,
        input_ref: preview.input_ref,
        template_id: preview.template.id,
        permission_mode: permissionMode,
        preview_hash: preview.preview_hash,
      })
      if (!mounted.current) return
      navigate(`/work/items/${encodeURIComponent(task.task_id)}`)
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'md' })}
    >
      <div className={card}>
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
          })}
        >
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              gap: 'xs',
            })}
          >
            <RiSparkling2Line size={20} aria-hidden="true" />
            <h2 className={css({ margin: 0, textStyle: 'titleMedium' })}>
              {t('composer.title')}
            </h2>
          </div>
          <label className={label} htmlFor="work-goal">
            {t('composer.goal')}
          </label>
          <TextArea
            id="work-goal"
            value={goal}
            rows={5}
            maxLength={bootstrap.limits.max_goal_chars}
            placeholder={t('composer.goalPlaceholder')}
            onChange={(event) => onGoalChange(event.target.value)}
            aria-invalid={invalidGoal && goal.length > 0}
          />
          <span className={invalidGoal && goal.length > 0 ? inputError : muted}>
            {t('composer.counter', {
              count: goalLength,
              max: bootstrap.limits.max_goal_chars,
            })}
          </span>
          <label className={label} htmlFor="work-background">
            {t('composer.background')}
          </label>
          <TextArea
            id="work-background"
            value={background}
            rows={3}
            maxLength={bootstrap.limits.max_background_chars}
            placeholder={t('composer.backgroundPlaceholder')}
            onChange={(event) => onBackgroundChange(event.target.value)}
          />
          <span className={muted}>
            {t('composer.counter', {
              count: backgroundLength,
              max: bootstrap.limits.max_background_chars,
            })}
          </span>
        </div>

        <div
          className={css({
            marginTop: 'lg',
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
          })}
        >
          <span className={label}>{t('composer.template')}</span>
          {templatesQ.isLoading ? (
            <span className={muted}>{t('loading')}</span>
          ) : (
            <div className={row}>
              {templates.map((template) => (
                <TemplateChoice
                  key={template.id}
                  template={template}
                  active={template.id === templateId}
                  onSelect={() => onTemplateChange(template.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div
          className={css({
            marginTop: 'lg',
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
          })}
        >
          <span className={label}>{t('composer.permission')}</span>
          <div className={row}>
            {bootstrap.allowed_permission_modes.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={permissionMode === mode}
                className={cx(
                  choice,
                  permissionMode === mode ? choiceActive : ''
                )}
                onClick={() => onModeChange(mode)}
              >
                <strong>{t(`composer.mode.${mode}`)}</strong>
                <span className={muted}>{t(`composer.modeHint.${mode}`)}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          className={css({
            marginTop: 'lg',
            padding: 'sm',
            borderRadius: 'control',
            backgroundColor: 'surface.canvas',
            display: 'flex',
            flexDirection: 'column',
            gap: 'xxs',
          })}
        >
          <span className={label}>{t('composer.boundaryTitle')}</span>
          <span className={muted}>
            {t('composer.boundary', {
              max: bootstrap.limits.max_goal_chars,
              artifact: bootstrap.limits.max_artifact_bytes,
            })}
          </span>
        </div>

        {error ? <p className={errorText}>{error}</p> : null}
        {!preview ? (
          <div
            className={css({
              marginTop: 'md',
              display: 'flex',
              justifyContent: 'flex-end',
            })}
          >
            <Button
              loading={createInput.isPending || createPreview.isPending}
              isDisabled={invalidGoal || invalidBackground || busy}
              icon={<RiArrowRightLine size={16} aria-hidden="true" />}
              onPress={requestPreview}
            >
              {t('composer.preview')}
            </Button>
          </div>
        ) : (
          <PreviewConfirm
            preview={preview}
            template={selectedTemplate}
            mode={permissionMode}
            loading={submitTask.isPending}
            onBack={() => setPreview(null)}
            onConfirm={confirmSubmit}
          />
        )}
      </div>
    </section>
  )
}

const TemplateChoice = ({
  template,
  active,
  onSelect,
}: {
  template: WorkTemplate
  active: boolean
  onSelect: () => void
}) => {
  const { t } = useTranslation('work')
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(choice, active ? choiceActive : '')}
      onClick={onSelect}
    >
      <span
        className={css({ display: 'flex', alignItems: 'center', gap: 'xxs' })}
      >
        {active ? <RiCheckLine size={14} aria-hidden="true" /> : null}
        <strong>{template.name}</strong>
      </span>
      <span className={muted}>{template.description}</span>
      <span className={muted}>
        {t('composer.templateVersion', { version: template.version })}
      </span>
    </button>
  )
}

const PreviewConfirm = ({
  preview,
  template,
  mode,
  loading,
  onBack,
  onConfirm,
}: {
  preview: WorkPreviewResponse
  template?: WorkTemplate
  mode: PermissionMode
  loading: boolean
  onBack: () => void
  onConfirm: () => void
}) => {
  const { t } = useTranslation('work')
  return (
    <div
      className={css({
        marginTop: 'lg',
        padding: 'md',
        border: '1px solid token(colors.border.focus)',
        borderRadius: 'control',
        backgroundColor: 'brand.50',
        display: 'flex',
        flexDirection: 'column',
        gap: 'sm',
      })}
    >
      <strong>{t('composer.confirmTitle')}</strong>
      <span className={muted}>{t('composer.confirmDescription')}</span>
      <dl
        className={css({
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: 'xxs md',
          margin: 0,
          textStyle: 'bodyMedium',
        })}
      >
        <dt className={label}>{t('composer.template')}</dt>
        <dd className={css({ margin: 0 })}>
          {template?.name ?? preview.template.name} v{preview.template.version}
        </dd>
        <dt className={label}>{t('composer.permission')}</dt>
        <dd className={css({ margin: 0 })}>{t(`composer.mode.${mode}`)}</dd>
        <dt className={label}>{t('composer.tokenCap')}</dt>
        <dd className={css({ margin: 0 })}>{preview.token_upper_bound}</dd>
        <dt className={label}>{t('composer.inputBytes')}</dt>
        <dd className={css({ margin: 0 })}>{preview.input_bytes}</dd>
      </dl>
      <div
        className={css({
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'sm',
        })}
      >
        <Button variant="secondary" onPress={onBack} isDisabled={loading}>
          {t('composer.back')}
        </Button>
        <Button loading={loading} onPress={onConfirm}>
          {t('composer.confirmSend')}
        </Button>
      </div>
    </div>
  )
}
