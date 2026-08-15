import { RiCheckLine } from '@remixicon/react'
import { Button as AriaButton } from 'react-aria-components'

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
}) => (
  <Popover aria-label="日历颜色" withArrow={false}>
    <AriaButton
      className={compact ? compactTriggerCls : triggerCls}
      style={{ backgroundColor: value }}
      aria-label={label}
      data-color={value}
    />
    {({ close }) => (
      <div className={pickerCls}>
        <strong className={titleCls}>日历颜色</strong>
        <div className={paletteCls} role="radiogroup" aria-label="日历颜色">
          {CALENDAR_COLOR_PALETTE.map((color) => {
            const selected = color.toLowerCase() === value.toLowerCase()
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`选择 ${color}`}
                title={color}
                className={swatchCls}
                style={{ backgroundColor: color }}
                onClick={() => {
                  onChange(color)
                  close()
                }}
              >
                {selected && <RiCheckLine aria-hidden="true" size={22} />}
              </button>
            )
          })}
        </div>
      </div>
    )}
  </Popover>
)

const triggerBase = {
  flexShrink: 0,
  padding: 0,
  border: '2px solid token(colors.greyscale.000)',
  borderRadius: 'full',
  outline: '1px solid token(colors.greyscale.300)',
  cursor: 'pointer',
  _focusVisible: {
    outline: '2px solid token(colors.primary.500)',
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
  _focusVisible: {
    outline: '2px solid token(colors.greyscale.900)',
    outlineOffset: '2px',
  },
})
