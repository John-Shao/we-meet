import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useConfig } from '@/api/useConfig'
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
  const externalEnabled = config?.calendar?.external_sync_enabled === true
  const externalCallback =
    externalEnabled &&
    new URLSearchParams(window.location.search).get('external') === 'connected'
  const [addOpen, setAddOpen] = useState(externalCallback)
  const [settings, setSettings] = useState<UnifiedCalendar | null>(null)
  const [share, setShare] = useState<UnifiedCalendar | null>(null)
  const [exporting, setExporting] = useState<UnifiedCalendar | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (externalCallback) setAddOpen(true)
  }, [externalCallback])
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
  const managed = calendars.filter(
    (row) => row.kind !== 'external' && row.capabilities.can_manage
  )
  const subscribed = calendars.filter(
    (row) => row.kind !== 'external' && !row.capabilities.can_manage
  )
  const external = calendars.filter((row) => row.kind === 'external')
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
              aria-label={`显示 ${calendar.display_name}`}
              onChange={(event) =>
                void update(calendar, { enabled: event.target.checked })
              }
            />
            <input
              type="color"
              value={calendar.color}
              aria-label={`${calendar.display_name} 颜色`}
              className={colorCls}
              onChange={(event) =>
                void update(calendar, { color: event.target.value })
              }
            />
            <span className={nameCls} title={calendar.display_name}>
              {calendar.display_name}
            </span>
            <details className={menuCls}>
              <summary aria-label={`${calendar.display_name} 菜单`}>
                ···
              </summary>
              <div className={menuPopupCls}>
                <button type="button" onClick={() => void only(calendar)}>
                  仅显示此日历
                </button>
                {calendar.capabilities.can_manage &&
                  calendar.kind !== 'resource' &&
                  calendar.kind !== 'external' && (
                    <button type="button" onClick={() => setSettings(calendar)}>
                      日历设置
                    </button>
                  )}
                {sharingEnabled && calendar.capabilities.can_share && (
                  <button type="button" onClick={() => setShare(calendar)}>
                    分享
                  </button>
                )}
                {exportEnabled && calendar.capabilities.can_export && (
                  <button type="button" onClick={() => setExporting(calendar)}>
                    导出日历
                  </button>
                )}
                {!calendar.capabilities.can_manage && (
                  <button
                    type="button"
                    onClick={() =>
                      void unsubscribeUnifiedCalendar(calendar.id)
                        .then(refresh)
                        .catch((reason) => setError(apiErrorMessage(reason)))
                    }
                  >
                    取消订阅
                  </button>
                )}
              </div>
            </details>
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
      {renderGroup('第三方日历', external)}
      {error && <p className={errorCls}>{error}</p>}
      {addOpen && (
        <AddCalendarDialog
          initialMode={externalCallback ? 'external' : 'subscribe'}
          externalEnabled={externalEnabled}
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
const colorCls = css({
  width: '0.8rem',
  height: '0.8rem',
  padding: 0,
  border: 0,
  background: 'transparent',
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
  '& summary': { listStyle: 'none', cursor: 'pointer', color: 'greyscale.500' },
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
