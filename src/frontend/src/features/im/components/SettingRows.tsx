import { RiArrowRightSLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Switch } from '@/primitives/Switch'

/**
 * The two row shapes the IM settings panels are made of.
 *
 * `SwitchRow` was two byte-identical private copies (GroupInfoPanel and
 * DirectSettingsPanel) before the bot detail page needed a third. `SettingRow`
 * is new: it is the "群机器人 ›" style row 飞书 uses for anything that opens a
 * sub-page.
 */

/** A row that opens a sub-page. `value` is the grey note before the chevron. */
export const SettingRow = ({
  label,
  value,
  onClick,
  disabled,
  testid,
}: {
  label: string
  value?: string
  onClick: () => void
  disabled?: boolean
  testid?: string
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-testid={testid}
    className={css({
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      width: '100%',
      padding: '0.625rem 1rem',
      border: 'none',
      borderBottom: '1px solid token(colors.greyscale.100)',
      backgroundColor: 'greyscale.000',
      textAlign: 'left',
      cursor: 'pointer',
      _hover: { backgroundColor: 'greyscale.50' },
      _disabled: { cursor: 'default', opacity: 0.6 },
    })}
  >
    <span
      className={css({ flex: 1, fontSize: '0.875rem', color: 'greyscale.900' })}
    >
      {label}
    </span>
    {value !== undefined && (
      <span className={css({ fontSize: '0.8125rem', color: 'greyscale.600' })}>
        {value}
      </span>
    )}
    <RiArrowRightSLine
      size={16}
      className={css({ flexShrink: 0, color: 'greyscale.500' })}
    />
  </button>
)

/** A boolean setting. 整行可点,标签作 Switch 子节点(对标飞书)。 */
export const SwitchRow = ({
  label,
  checked,
  onChange,
  disabled,
  testid,
}: {
  label: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
  testid?: string
}) => (
  <div
    className={css({
      display: 'flex',
      alignItems: 'center',
      padding: '0.625rem 1rem',
      borderBottom: '1px solid token(colors.greyscale.100)',
    })}
  >
    <Switch
      isSelected={checked}
      isDisabled={disabled}
      onChange={onChange}
      data-testid={testid}
      className={css({
        width: '100%',
        flexDirection: 'row-reverse',
        justifyContent: 'space-between',
      })}
    >
      <span className={css({ fontSize: '0.875rem', color: 'greyscale.900' })}>
        {label}
      </span>
    </Switch>
  </div>
)
