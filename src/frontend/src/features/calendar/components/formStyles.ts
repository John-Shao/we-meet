/**
 * Shared field styles for the event form (P2) and the blocks embedded in it.
 *
 * Lifted out of `CreateEventDialog` so the meeting-room block (P9) can look
 * like it belongs there instead of carrying a near-copy of the same rules.
 */

import { css } from '@/styled-system/css'

export const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

export const fieldCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  flex: 1,
  minWidth: '12rem',
})

export const labelCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })

export const ghostBtn = css({
  paddingX: '0.875rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '0.875rem',
  cursor: 'pointer',
})

export const chipCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.100',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
})
