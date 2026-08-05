import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { Button } from '@/primitives'

import { BotAvatar } from './BotAvatar'
import { BOT_COLORS, botColorAt } from './botPalette'
import { inputCls, modalFoot } from './botStyles'

const NAME_MAX = 32
const DESC_MAX = 256

export interface BotFormValue {
  name: string
  description: string
  avatarColorIndex: number
}

const counterCls = css({
  flexShrink: 0,
  fontSize: '0.75rem',
  color: 'greyscale.500',
  alignSelf: 'flex-end',
})

const fieldLabelCls = css({
  display: 'block',
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  marginBottom: '0.375rem',
})

const swatchCls = css({
  width: '1.5rem',
  height: '1.5rem',
  borderRadius: '999px',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
})

// ⚠️ Both states carry the full declaration. `cx` resolves same-property
// conflicts by stylesheet order, not by the order written here, so a
// "selected-only" override would win or lose unpredictably.
const swatchOnCls = css({
  outline: '2px solid token(colors.brand.600)',
  outlineOffset: '2px',
})
const swatchOffCls = css({
  outline: '2px solid transparent',
  outlineOffset: '2px',
})

/**
 * 自定义机器人表单 — used for both creating and editing (the fields are the
 * same either way, which is why there is one component).
 *
 * The avatar is a colour choice, not an upload: the server renders the swatch
 * into a real image so every client (and the push notification) has one path.
 */
export const CustomBotForm = ({
  initial,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: Partial<BotFormValue>
  busy?: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: (value: BotFormValue) => void
}) => {
  const { t } = useTranslation('im')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [colorIndex, setColorIndex] = useState(initial?.avatarColorIndex ?? 0)
  const nameRef = useRef<HTMLInputElement>(null)

  // Modal's initialFocusRef only fires on mount, and this component appears on
  // the dialog's *second* page, so it focuses itself.
  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  return (
    <>
      <div className={css({ padding: '1rem', overflowY: 'auto' })}>
        <span className={fieldLabelCls}>{t('bots.form.avatar')}</span>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '1rem',
            flexWrap: 'wrap',
          })}
        >
          <BotAvatar name={name || '#'} colorIndex={colorIndex} size="2.5rem" />
          {BOT_COLORS.map((hex, index) => (
            <button
              key={hex}
              type="button"
              aria-label={t('bots.form.colorOption', { index: index + 1 })}
              aria-pressed={index === colorIndex}
              onClick={() => setColorIndex(index)}
              style={{ background: botColorAt(index) }}
              className={cx(
                swatchCls,
                index === colorIndex ? swatchOnCls : swatchOffCls
              )}
            />
          ))}
        </div>

        <label className={fieldLabelCls} htmlFor="bot-name">
          {t('bots.form.name')}
        </label>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1rem',
          })}
        >
          <input
            id="bot-name"
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX}
            placeholder={t('bots.form.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            data-testid="bot-name"
            className={inputCls}
          />
          <span className={counterCls}>
            {name.length}/{NAME_MAX}
          </span>
        </div>

        <label className={fieldLabelCls} htmlFor="bot-desc">
          {t('bots.form.desc')}
        </label>
        <div className={css({ display: 'flex', gap: '0.5rem' })}>
          <textarea
            id="bot-desc"
            value={description}
            rows={3}
            maxLength={DESC_MAX}
            placeholder={t('bots.form.descPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="bot-desc"
            className={cx(inputCls, css({ resize: 'vertical' }))}
          />
          <span className={counterCls}>
            {description.length}/{DESC_MAX}
          </span>
        </div>
      </div>

      <div className={modalFoot}>
        <Button variant="secondary" size="action" onPress={onCancel}>
          {t('manage.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          isDisabled={!name.trim() || busy}
          onPress={() =>
            onSubmit({
              name: name.trim(),
              description: description.trim(),
              avatarColorIndex: colorIndex,
            })
          }
        >
          {submitLabel}
        </Button>
      </div>
    </>
  )
}
