/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Named scroll regions need keyboard focus for scrolling and restoration cancellation. */
import { useRecordPanelScroll } from '../hooks/useRecordPanelScroll'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { css } from '@/styled-system/css'

const ToolsContext = createContext<HTMLDivElement | null | undefined>(undefined)

/** Tools stay outside the panel's scroller without moving query ownership. */
export function RecordPanel({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const scroll = useRecordPanelScroll(label)
  return (
    <ToolsContext.Provider value={host}>
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 0',
          minHeight: 0,
          minWidth: 0,
        })}
      >
        <div
          ref={setHost}
          role="group"
          aria-label={label}
          data-record-toolbar
          className={toolsStyle}
        />
        <div
          role="region"
          aria-label={label}
          tabIndex={0}
          {...scroll}
          data-record-scroll
          className={css({
            flex: '1 1 0',
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: { base: 'lg', md: '2xl' },
            overflowWrap: 'anywhere',
          })}
        >
          {children}
        </div>
      </div>
    </ToolsContext.Provider>
  )
}

export function RecordPanelTools({ children }: { children: ReactNode }) {
  const host = useContext(ToolsContext)
  if (host === undefined) return <div className={toolsStyle}>{children}</div>
  return host ? createPortal(children, host) : null
}

const toolsStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'sm',
  flexShrink: 0,
  minWidth: 0,
  paddingX: 'lg',
  paddingY: 'sm',
  backgroundColor: 'surface.default',
  borderBottom: '1px solid token(colors.border.subtle)',
  maxHeight: '40%',
  overflowY: 'auto',
  '&:empty': { display: 'none' },
  '& > *': { minWidth: 0, maxWidth: '100%' },
})
