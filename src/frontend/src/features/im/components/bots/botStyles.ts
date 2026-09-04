import { css } from '@/styled-system/css'

/** Shared chrome for the bot pages and dialogs (mirrors AddMemberDialog's). */

export const modalHead = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

// 聚焦描边由 styles/index.css 的「统一焦点描边」统一给出,这里不要再写 _focus。
export const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
})

export const sectionCls = css({
  padding: '0.875rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})

export const sectionLabelCls = css({
  fontSize: '0.8125rem',
  color: 'greyscale.600',
  marginBottom: '0.375rem',
})

export const hintCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.500',
  marginTop: '0.375rem',
  lineHeight: 1.5,
})

/**
 * The webhook URL box. `wordBreak: break-all` is not optional — the panel is
 * 260–560px wide and a signed URL does not fit on one line at any of them.
 */
export const linkBoxCls = css({
  wordBreak: 'break-all',
  padding: '0.5rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.50',
  border: '1px solid token(colors.greyscale.200)',
  fontFamily: 'mono',
  fontSize: '0.75rem',
  color: 'greyscale.800',
})

export const linkBtnCls = css({
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  fontSize: '0.8125rem',
  color: 'primary.500',
  _hover: { textDecoration: 'underline' },
})

export const dangerBtnCls = css({
  width: '100%',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'error.500',
  fontSize: '0.875rem',
  fontWeight: 'medium',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.50' },
})
