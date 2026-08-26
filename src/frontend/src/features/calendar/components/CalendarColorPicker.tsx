import { RiCheckLine } from '@remixicon/react'
import { Button as AriaButton } from 'react-aria-components'
import { useTranslation } from 'react-i18next'

import { Popover } from '@/primitives'
import { css } from '@/styled-system/css'

import { CALENDAR_COLOR_PALETTE } from '../utils/calendarColors'

export const CalendarColorPicker = ({
  value,
  label,
  compact = false,
  onChange,
}: {
  value: string
  label: string
  compact?: boolean
  onChange: (value: string) => void
}) => {
  const { t } = useTranslation('calendar')
  return (
    <Popover aria-label={t('color.pickerTitle')} withArrow={false}>
      <AriaButton
        className={compact ? compactTriggerCls : triggerCls}
        style={{ backgroundColor: value }}
        aria-label={label}
        data-color={value}
      />
      {({ close }) => (
        <CalendarColorPalette
          value={value}
          onChange={(color) => {
            onChange(color)
            close()
          }}
        />
      )}
    </Popover>
  )
}

export const CalendarColorPalette = ({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) => {
  const { t } = useTranslation('calendar')
  return (
    <div className={pickerCls}>
      <strong className={titleCls}>{t('color.pickerTitle')}</strong>
      <div
        className={paletteCls}
        role="radiogroup"
        aria-label={t('color.pickerTitle')}
      >
        {CALENDAR_COLOR_PALETTE.map((color) => {
          const selected = color.toLowerCase() === value.toLowerCase()
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t('color.select', { color })}
              title={color}
              className={swatchCls}
              style={{ backgroundColor: color }}
              onClick={() => onChange(color)}
            >
              {selected && <RiCheckLine aria-hidden="true" size={22} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const triggerBase = {
  flexShrink: 0,
  padding: 0,
  border: '2px solid token(colors.greyscale.000)',
  borderRadius: 'full',
  outline: '1px solid token(colors.greyscale.300)',
  cursor: 'pointer',
  // 焦点环用 focusRing token(随主题翻转),与全站统一 —— 见 styles/index.css
  // 的「统一焦点描边」②。静止态那条 1px 灰 outline 是装饰边,不是焦点态。
  _focusVisible: {
    outline: '2px solid token(colors.focusRing)',
    outlineOffset: '2px',
  },
} as const

const triggerCls = css({
  ...triggerBase,
  width: '2rem',
  height: '2rem',
})

const compactTriggerCls = css({
  ...triggerBase,
  width: '1rem',
  height: '1rem',
})

const pickerCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
})

const titleCls = css({
  color: 'greyscale.900',
  fontSize: '0.875rem',
  fontWeight: 'semibold',
})

const paletteCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(6, 2.25rem)',
  gap: '0.5rem',
})

const swatchCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2.25rem',
  height: '2.25rem',
  padding: 0,
  border: 0,
  borderRadius: 'full',
  color: 'white',
  cursor: 'pointer',
  _hover: { transform: 'scale(1.08)' },
  // 与全站统一的焦点环(见 styles/index.css 的「统一焦点描边」②)。原先写死
  // greyscale.900,想的是「中性色在任何色板上都读得出」—— 但 2px offset 的环
  // 落在色板**外面**的面上,底色是面板而不是色块,蓝环一样清楚;而且那行其实
  // 一直被 index.css 的兜底环盖着,从未真正生效过。
  _focusVisible: {
    outline: '2px solid token(colors.focusRing)',
    outlineOffset: '2px',
  },
})
