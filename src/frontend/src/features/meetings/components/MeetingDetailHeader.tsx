import type { ReactNode } from 'react'
import { RiArrowRightSLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import { css } from '@/styled-system/css'
import { useMeetingListReturn } from '../hooks/useMeetingListNavigation'

/** Shared list > detail heading for meeting pages. */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard focus reveals the full truncated heading without making it an action. */
export function MeetingDetailHeader({
  viewerId,
  listHref,
  listLabel,
  title,
  titleAction,
  metadata,
  actions,
}: {
  viewerId?: string
  listHref: string
  listLabel: string
  title: string
  titleAction?: ReactNode
  metadata?: ReactNode
  actions?: ReactNode
}) {
  const { t } = useTranslation('meetings')
  const back = useMeetingListReturn(viewerId, listHref)
  return (
    <header className={header}>
      <nav aria-label={t('library.navigation')} className={navigation}>
        <Link {...back} className={parentLink}>
          {listLabel}
        </Link>
        <RiArrowRightSLine size={20} aria-hidden className={separator} />
        <div className={current}>
          <div className={titleRow}>
            <h1
              tabIndex={0}
              aria-current="page"
              title={title}
              className={heading}
            >
              {title}
            </h1>
            {titleAction}
          </div>
          {metadata && <div className={meta}>{metadata}</div>}
        </div>
      </nav>
      {actions && <div className={actionRow}>{actions}</div>}
    </header>
  )
}
/* eslint-enable jsx-a11y/no-noninteractive-tabindex */

const header = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 'md',
  paddingY: 'lg',
  minWidth: 0,
})
const navigation = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'sm',
  minWidth: 0,
  flex: '1 1 16rem',
})
const parentLink = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 'controlHeight.compact',
  textStyle: 'bodyMedium',
  color: 'text.secondary',
  textDecoration: 'none',
  borderRadius: 'field',
  _hover: { color: 'text.link', textDecoration: 'underline' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})
const separator = css({
  flexShrink: 0,
  color: 'icon.secondary',
  marginTop: 'xs',
})
const current = css({ minWidth: 0, flex: 1 })
const titleRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  minWidth: 0,
  minHeight: 'controlHeight.compact',
  '& > button': { flexShrink: 0 },
  '&:has(> form)': { flexWrap: 'wrap' },
  '& > form': { flexBasis: '100%' },
})
const heading = css({
  textStyle: 'headlineSmall',
  color: 'text.primary',
  margin: 0,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: '0 1 auto',
  maxWidth: '100%',
  borderRadius: 'field',
  _focusVisible: {
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})
const meta = css({
  textStyle: 'bodySmall',
  color: 'text.secondary',
  marginTop: 'xs',
  overflowWrap: 'anywhere',
})
const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 'sm',
  marginLeft: 'auto',
  maxWidth: '100%',
})
