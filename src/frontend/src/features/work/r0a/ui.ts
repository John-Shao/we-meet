import { css } from '@/styled-system/css'

export const page = css({
  width: '100%',
  maxWidth: '76rem',
  margin: '0 auto',
  paddingX: { base: 'md', md: 'xl' },
  paddingY: 'lg',
  display: 'flex',
  flexDirection: 'column',
  gap: 'lg',
})

export const card = css({
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  padding: 'lg',
})

export const notice = css({
  margin: 0,
  padding: 'sm',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  backgroundColor: 'surface.canvas',
  color: 'text.secondary',
  textStyle: 'bodyMedium',
})

export const muted = css({
  color: 'text.secondary',
  textStyle: 'bodyMedium',
})

export const label = css({
  color: 'text.secondary',
  textStyle: 'labelMedium',
  fontWeight: 'semibold',
})

export const row = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  flexWrap: 'wrap',
})

export const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
})

export const sectionTitle = css({
  margin: 0,
  textStyle: 'titleMedium',
  color: 'text.primary',
})

export const errorText = css({
  color: 'status.danger.container-text',
  textStyle: 'bodyMedium',
})

export const inputError = css({
  color: 'status.danger.container-text',
  textStyle: 'labelMedium',
})
