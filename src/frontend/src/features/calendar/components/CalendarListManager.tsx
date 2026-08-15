import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useConfig } from '@/api/useConfig'
import { roomBuildingIdentifier } from '@/features/meeting-rooms'
import { css } from '@/styled-system/css'

import {
  fetchCalendars,
  setCalendarSubscription,
  unsubscribeUnifiedCalendar,
  type UnifiedCalendar,
} from '../api/calendars'
import {
  AddCalendarDialog,
  CalendarExportDialog,
  CalendarSettingsDialog,
  CalendarShareDialog,
} from './CalendarManagementDialogs'
import { CalendarColorPicker } from './CalendarColorPicker'

const calendarDisplayName = (calendar: UnifiedCalendar): string => {
  const room = calendar.meeting_room
  if (!room) return calendar.display_name
  return (
    roomBuildingIdentifier(room.node?.name ?? '', room) || calendar.display_name
  )
}

export const CalendarListManager = ({
  onChanged,
}: {
  onChanged: () => void
}) => {
  const qc = useQueryClient()
  const { data: config } = useConfig()
  const unifiedEnabled = config?.calendar?.enabled === true
  const sharingEnabled = config?.calendar?.sharing_enabled === true
  const exportEnabled = config?.calendar?.export_enabled === true
  const [addOpen, setAddOpen] = useState(false)
  const [settings, setSettings] = useState<UnifiedCalendar | null>(null)
  const [share, setShare] = useState<UnifiedCalendar | null>(null)
  const [exporting, setExporting] = useState<UnifiedCalendar | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const openMenuRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const { data: calendars = [] } = useQuery({
    queryKey: ['calendar', 'unified'],
    queryFn: fetchCalendars,
    enabled: unifiedEnabled,
    staleTime: 30_000,
  })
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['calendar'] })
    onChanged()
  }
  const update = async (
    calendar: UnifiedCalendar,
    payload: { enabled?: boolean; color?: string }
  ) => {
    setError('')
    try {
      await setCalendarSubscription(calendar.id, payload)
      await refresh()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    }
  }
  const only = async (calendar: UnifiedCalendar) => {
    setError('')
    try {
      await Promise.all(
        calendars.map((row) =>
          setCalendarSubscription(row.id, {
            enabled: row.id === calendar.id,
            color: row.color,
          })
        )
      )
      await refresh()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    }
  }
  const managed = calendars.filter((row) => row.capabilities.can_manage)
  const subscribed = calendars.filter((row) => !row.capabilities.can_manage)

  useEffect(() => {
    if (!openMenuId) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!openMenuRef.current?.contains(event.target as Node)) {
        setOpenMenuId(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuId(null)
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenuId])

  const renderGroup = (title: string, rows: UnifiedCalendar[]) => (
    <section className={groupCls}>
      <h3 className={groupTitleCls}>{title}</h3>
      {rows.length === 0 ? (
        <span className={mutedCls}>暂无</span>
      ) : (
        rows.map((calendar) => (
          <div key={calendar.id} className={calendarRowCls}>
            <input
              type="checkbox"
              checked={calendar.enabled}
              aria-label={`显示 ${calendarDisplayName(calendar)}`}
              onChange={(event) =>
                void update(calendar, { enabled: event.target.checked })
              }
            />
            <CalendarColorPicker
              value={calendar.color}
              label={`${calendarDisplayName(calendar)} 颜色`}
              compact
              onChange={(color) => void update(calendar, { color })}
            />
            <span className={nameCls} title={calendarDisplayName(calendar)}>
              {calendarDisplayName(calendar)}
            </span>
            <div
              className={menuCls}
              ref={openMenuId === calendar.id ? openMenuRef : undefined}
            >
              <button
                type="button"
                aria-label={`${calendarDisplayName(calendar)} 菜单`}
                aria-haspopup="menu"
                aria-expanded={openMenuId === calendar.id}
                onClick={() =>
                  setOpenMenuId((current) =>
                    current === calendar.id ? null : calendar.id
                  )
                }
              >
                ···
              </button>
              {openMenuId === calendar.id && (
                <div className={menuPopupCls} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenuId(null)
                      void only(calendar)
                    }}
                  >
                    仅显示此日历
                  </button>
                  {calendar.capabilities.can_manage &&
                    calendar.kind !== 'resource' && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenuId(null)
                          setSettings(calendar)
                        }}
                      >
                        日历设置
                      </button>
                    )}
                  {sharingEnabled && calendar.capabilities.can_share && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenuId(null)
                        setShare(calendar)
                      }}
                    >
                      分享
                    </button>
                  )}
                  {exportEnabled && calendar.capabilities.can_export && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenuId(null)
                        setExporting(calendar)
                      }}
                    >
                      导出日历
                    </button>
                  )}
                  {!calendar.capabilities.can_manage && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenuId(null)
                        void unsubscribeUnifiedCalendar(calendar.id)
                          .then(refresh)
                          .catch((reason) => setError(apiErrorMessage(reason)))
                      }}
                    >
                      取消订阅
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  )
  if (!unifiedEnabled) return null
  return (
    <>
      <button type="button" className={addCls} onClick={() => setAddOpen(true)}>
        ＋ 添加日历
      </button>
      {renderGroup('我管理的', managed)}
      {renderGroup('我订阅的', subscribed)}
      {error && <p className={errorCls}>{error}</p>}
      {addOpen && (
        <AddCalendarDialog
          onClose={() => setAddOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
      {settings && (
        <CalendarSettingsDialog
          calendar={settings}
          onClose={() => setSettings(null)}
          onChanged={() => void refresh()}
        />
      )}
      {share && (
        <CalendarShareDialog calendar={share} onClose={() => setShare(null)} />
      )}
      {exporting && (
        <CalendarExportDialog
          calendar={exporting}
          onClose={() => setExporting(null)}
        />
      )}
    </>
  )
}

const addCls = css({
  width: '100%',
  border: 0,
  borderRadius: '0.4rem',
  background: 'greyscale.100',
  color: 'greyscale.800',
  textAlign: 'left',
  padding: '0.5rem',
  cursor: 'pointer',
})
const groupCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})
const groupTitleCls = css({
  margin: 0,
  color: 'greyscale.600',
  fontSize: '0.78rem',
  fontWeight: 600,
})
const calendarRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  minWidth: 0,
  position: 'relative',
})
const nameCls = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '0.82rem',
})
const menuCls = css({
  position: 'relative',
  '& > button': {
    border: 0,
    padding: 0,
    background: 'transparent',
    cursor: 'pointer',
    color: 'greyscale.500',
  },
})
const menuPopupCls = css({
  position: 'absolute',
  zIndex: 4,
  right: 0,
  top: '1.25rem',
  minWidth: '9rem',
  display: 'flex',
  flexDirection: 'column',
  padding: '0.3rem',
  borderRadius: '0.4rem',
  border: '1px solid token(colors.greyscale.200)',
  background: 'greyscale.000',
  boxShadow: 'sm',
  '& button': {
    border: 0,
    background: 'transparent',
    textAlign: 'left',
    padding: '0.45rem',
    cursor: 'pointer',
    _hover: { background: 'greyscale.100' },
  },
})
const mutedCls = css({ color: 'greyscale.400', fontSize: '0.75rem' })
const errorCls = css({ color: '#dc2626', fontSize: '0.75rem' })
