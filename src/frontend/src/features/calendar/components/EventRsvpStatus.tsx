import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'

import type { RSVPStatus } from '../api/ApiCalendar'

const statusVisuals: Record<
  RSVPStatus,
  { glyph: string; className: string; translationKey: string }
> = {
  accepted: {
    glyph: '✓',
    className: css({
      color: '#15803D',
      borderColor: '#86C89A',
      backgroundColor: '#F0FDF4',
      _dark: { color: '#86EFAC', backgroundColor: '#173724' },
    }),
    translationKey: 'rsvp.accepted',
  },
  needs_action: {
    glyph: '…',
    className: css({
      color: '#6D28D9',
      borderColor: '#C4B5FD',
      backgroundColor: '#F5F3FF',
      _dark: { color: '#C4B5FD', backgroundColor: '#2E2350' },
    }),
    translationKey: 'rsvp.needsAction',
  },
  tentative: {
    glyph: '?',
    className: css({
      color: '#92400E',
      borderColor: '#FCD34D',
      backgroundColor: '#FFFBEB',
      _dark: { color: '#FCD34D', backgroundColor: '#493313' },
    }),
    translationKey: 'rsvp.tentative',
  },
  declined: {
    glyph: '×',
    className: css({
      color: 'greyscale.600',
      borderColor: 'greyscale.400',
      backgroundColor: 'greyscale.100',
    }),
    translationKey: 'rsvp.declined',
  },
}

const markCls = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1rem',
  height: '1rem',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '999px',
  fontSize: '0.625rem',
  fontWeight: 700,
  lineHeight: 1,
  '&[data-glyph-only="true"]': {
    width: '0.75rem',
    height: '0.75rem',
    borderWidth: 0,
    backgroundColor: 'transparent',
    _dark: { backgroundColor: 'transparent' },
  },
})

/** RSVP is a compact, labelled badge so the event hue remains free for owner. */
export const EventRsvpStatus = ({
  status,
  className,
  glyphOnly = false,
}: {
  status?: RSVPStatus | null
  className?: string
  glyphOnly?: boolean
}) => {
  const { t } = useTranslation('calendar')
  // Legacy organizer rows have no attendee RSVP and are treated as accepted.
  const visual = statusVisuals[status ?? 'accepted']
  const label = t(visual.translationKey)

  return (
    <span
      className={cx(markCls, visual.className, className)}
      aria-label={label}
      title={label}
      data-rsvp-status={status ?? 'accepted'}
      data-glyph-only={glyphOnly}
    >
      {visual.glyph}
    </span>
  )
}
