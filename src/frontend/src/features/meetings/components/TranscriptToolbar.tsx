/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Named scroll regions need keyboard focus for scrolling and restoration cancellation. */
import { useRecordPanelScroll } from '../hooks/useRecordPanelScroll'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { RiFocus3Line } from '@remixicon/react'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { TranscriptExportControl } from './TranscriptExportControl'
import { TranscriptReplacementControl } from './TranscriptReplacementControl'

type Slots = {
  search: HTMLDivElement | null
  searchToggle: HTMLDivElement | null
  primary: HTMLDivElement | null
  playback: HTMLDivElement | null
  filters: HTMLDivElement | null
}
const ToolbarContext = createContext<Slots | null>(null)

/** Keep tools outside the scroll region; readers retain their own query/edit state. */
export function TranscriptToolbar({
  viewerId,
  recordId,
  canReplace,
  children,
}: {
  viewerId: string
  recordId: string
  canReplace?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('meetings')
  const scroll = useRecordPanelScroll('transcript')
  const [search, setSearch] = useState<HTMLDivElement | null>(null)
  const [searchToggle, setSearchToggle] = useState<HTMLDivElement | null>(null)
  const [primary, setPrimary] = useState<HTMLDivElement | null>(null)
  const [playback, setPlayback] = useState<HTMLDivElement | null>(null)
  const [filters, setFilters] = useState<HTMLDivElement | null>(null)
  const layout = (replacement: ReactNode, panel: ReactNode) => (
    <ToolbarContext.Provider
      value={{ search, searchToggle, primary, playback, filters }}
    >
      <div className={layoutStyle}>
        <div
          className={toolsStyle}
          role="group"
          aria-label={t('transcriptToolbar.label')}
        >
          <div className={rowStyle}>
            <div ref={setPrimary} className={primaryStyle} />
            <div ref={setSearchToggle} className={toggleStyle} />
            <div ref={setSearch} className={searchStyle} />
            <div className={actionsStyle}>
              <div ref={setPlayback} className={slotStyle} />
              {replacement}
              <TranscriptExportControl recordId={recordId} />
            </div>
          </div>
          <div ref={setFilters} className={filtersStyle} />
          {panel && <div className={expandedStyle}>{panel}</div>}
        </div>
        <div
          {...scroll}
          role="region"
          aria-label={t('library.text')}
          tabIndex={0}
          data-transcript-scroll
          className={scrollStyle}
        >
          {children}
        </div>
      </div>
    </ToolbarContext.Provider>
  )
  return canReplace ? (
    <TranscriptReplacementControl
      viewerId={viewerId}
      recordId={recordId}
      render={layout}
    />
  ) : (
    layout(null, null)
  )
}

export function TranscriptSearchToggle({ children }: { children: ReactNode }) {
  const slots = useContext(ToolbarContext)
  if (!slots) return children
  return slots.searchToggle ? createPortal(children, slots.searchToggle) : null
}

/** Portals preserve reader state and events while placing controls above its scroller. */
export function TranscriptToolbarSlots({
  search,
  playback,
  filters,
}: {
  search: ReactNode
  playback?: ReactNode
  filters?: ReactNode
}) {
  const slots = useContext(ToolbarContext)
  if (!slots)
    return (
      <>
        {search}
        {filters}
        {playback}
      </>
    )
  return (
    <>
      {slots.search && createPortal(search, slots.search)}
      {slots.playback && createPortal(playback, slots.playback)}
      {slots.filters && createPortal(filters, slots.filters)}
    </>
  )
}

export function TranscriptPlaybackButton({
  available,
  needed,
  editing,
  onResume,
}: {
  available: boolean
  needed: boolean
  editing: boolean
  onResume: () => void
}) {
  const { t } = useTranslation('meetings')
  const toolbar = useContext(ToolbarContext)
  if (!available || (!toolbar && !needed)) return null
  const button = (
    <Button
      size="sm"
      variant="secondaryText"
      aria-label={t('library.backToPlayback')}
      tooltip={t('library.backToPlayback')}
      icon={<RiFocus3Line size={16} aria-hidden />}
      isDisabled={editing || !needed}
      onPress={onResume}
    >
      {t('library.backToPlayback')}
    </Button>
  )
  return toolbar
    ? toolbar.primary && createPortal(button, toolbar.primary)
    : button
}

const layoutStyle = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
})
const toolsStyle = css({
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  minHeight: 0,
  maxHeight: '65%',
  backgroundColor: 'surface.default',
  paddingX: 'lg',
  paddingY: 'sm',
  borderBottom: '1px solid token(colors.border.subtle)',
})
const rowStyle = css({
  flexShrink: 0,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'sm',
  minWidth: 0,
})
const searchStyle = css({
  flex: { base: '1 1 100%', md: '1 1 12rem' },
  order: { base: 4, md: 1 },
  minWidth: 0,
  '& > form': { margin: 0 },
  '&:has(> form[data-search-expanded=false])': {
    display: { base: 'none', md: 'block' },
  },
  _empty: { display: 'none' },
})
const primaryStyle = css({
  order: { base: 1, md: 2 },
  flexShrink: 0,
  _empty: { display: 'none' },
})
const toggleStyle = css({
  display: { base: 'flex', md: 'none' },
  order: 2,
  marginLeft: 'auto',
  _empty: { display: 'none' },
})
const actionsStyle = css({
  order: 3,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'sm',
  marginLeft: { base: 0, md: 'auto' },
  minWidth: 0,
})
const slotStyle = css({ display: 'contents' })
const filtersStyle = css({
  flexShrink: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'sm',
  alignItems: 'center',
  '& > div': { marginY: 'xs', minWidth: 0, maxWidth: '100%' },
  _empty: { display: 'none' },
})
const expandedStyle = css({
  flex: '0 1 auto',
  minHeight: 0,
  maxHeight: 'min(24vh, 14rem)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  marginTop: 'sm',
  padding: 'md',
  backgroundColor: 'surface.canvas',
  borderRadius: 'field',
})
const scrollStyle = css({
  flex: '1 1 0',
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  padding: 'lg',
  overflowWrap: 'anywhere',
  '& mark[data-search-current=true]': {
    outline: '2px solid token(colors.border.focus)',
  },
})
