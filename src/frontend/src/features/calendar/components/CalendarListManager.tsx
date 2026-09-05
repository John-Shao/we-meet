import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RiMoreLine } from '@remixicon/react'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { useConfig } from '@/api/useConfig'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { roomBuildingIdentifier } from '@/features/meeting-rooms'
import { ActionMenuItem, ActionMenuSurface, IconButton } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
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
import {
  CalendarColorPalette,
  CalendarColorPicker,
} from './CalendarColorPicker'

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
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const { data: config } = useConfig()
  const unifiedEnabled = config?.calendar?.enabled === true
  const sharingEnabled = config?.calendar?.sharing_enabled === true
  const exportEnabled = config?.calendar?.export_enabled === true
  const [addOpen, setAddOpen] = useState(false)
  const [settings, setSettings] = useState<UnifiedCalendar | null>(null)
  const [share, setShare] = useState<UnifiedCalendar | null>(null)
  const [exporting, setExporting] = useState<UnifiedCalendar | null>(null)
  const [coloring, setColoring] = useState<UnifiedCalendar | null>(null)
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
        <span className={mutedCls}>{t('sidebar.empty')}</span>
      ) : (
        rows.map((calendar) => (
          <div key={calendar.id} className={calendarRowCls}>
            <Checkbox
              size="sm"
              isSelected={calendar.enabled}
              aria-label={t('sidebar.toggleCalendar', {
                calendar: calendarDisplayName(calendar),
              })}
              onChange={(enabled) => void update(calendar, { enabled })}
            />
            <CalendarColorPicker
              value={calendar.color}
              label={t('sidebar.calendarColor', {
                calendar: calendarDisplayName(calendar),
              })}
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
              <IconButton
                label={t('sidebar.calendarMenu', {
                  calendar: calendarDisplayName(calendar),
                })}
                size="icon24"
                aria-haspopup="menu"
                aria-expanded={openMenuId === calendar.id}
                onPress={() =>
                  setOpenMenuId((current) =>
                    current === calendar.id ? null : calendar.id
                  )
                }
              >
                <RiMoreLine size={16} aria-hidden="true" />
              </IconButton>
              {openMenuId === calendar.id && (
                <ActionMenuSurface
                  ariaLabel={t('sidebar.calendarMenu', {
                    calendar: calendarDisplayName(calendar),
                  })}
                  onClose={() => setOpenMenuId(null)}
                  className={menuPopupCls}
                >
                  <ActionMenuItem
                    density="compact"
                    onClick={() => {
                      setOpenMenuId(null)
                      void only(calendar)
                    }}
                  >
                    {t('sidebar.onlyThisCalendar')}
                  </ActionMenuItem>
                  {!calendar.capabilities.can_manage && (
                    <ActionMenuItem
                      density="compact"
                      onClick={() => {
                        setOpenMenuId(null)
                        setColoring(calendar)
                      }}
                    >
                      {t('sidebar.setColor')}
                    </ActionMenuItem>
                  )}
                  {calendar.capabilities.can_manage &&
                    calendar.kind !== 'resource' && (
                      <ActionMenuItem
                        density="compact"
                        onClick={() => {
                          setOpenMenuId(null)
                          setSettings(calendar)
                        }}
                      >
                        {t('sidebar.calendarSettings')}
                      </ActionMenuItem>
                    )}
                  {sharingEnabled && calendar.capabilities.can_share && (
                    <ActionMenuItem
                      density="compact"
                      onClick={() => {
                        setOpenMenuId(null)
                        setShare(calendar)
                      }}
                    >
                      {t('sidebar.share')}
                    </ActionMenuItem>
                  )}
                  {exportEnabled && calendar.capabilities.can_export && (
                    <ActionMenuItem
                      density="compact"
                      onClick={() => {
                        setOpenMenuId(null)
                        setExporting(calendar)
                      }}
                    >
                      {t('sidebar.export')}
                    </ActionMenuItem>
                  )}
                  {!calendar.capabilities.can_manage && (
                    <ActionMenuItem
                      density="compact"
                      tone="danger"
                      onClick={() => {
                        setOpenMenuId(null)
                        void unsubscribeUnifiedCalendar(calendar.id)
                          .then(refresh)
                          .catch((reason) => setError(apiErrorMessage(reason)))
                      }}
                    >
                      {t('sidebar.unsubscribe')}
                    </ActionMenuItem>
                  )}
                </ActionMenuSurface>
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
        {t('sidebar.addCalendar')}
      </button>
      {renderGroup(t('sidebar.managed'), managed)}
      {renderGroup(t('sidebar.subscribed'), subscribed)}
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
      {coloring && (
        <Modal
          onClose={() => setColoring(null)}
          ariaLabel={t('sidebar.setCalendarColor', {
            calendar: calendarDisplayName(coloring),
          })}
          maxWidth="22rem"
        >
          <header className={colorDialogHeaderCls}>
            <h2 className={colorDialogTitleCls}>{t('sidebar.setColor')}</h2>
            <ModalCloseButton
              onClose={() => setColoring(null)}
              label={t('detail.close')}
            />
          </header>
          <div className={colorDialogBodyCls}>
            <span className={nameCls}>{calendarDisplayName(coloring)}</span>
            <CalendarColorPalette
              value={coloring.color}
              onChange={(color) => {
                setColoring(null)
                void update(coloring, { color })
              }}
            />
          </div>
        </Modal>
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
})
const menuPopupCls = css({
  position: 'absolute',
  zIndex: 4,
  right: 0,
  top: '1.25rem',
  minWidth: '9rem',
})
const mutedCls = css({ color: 'greyscale.400', fontSize: '0.75rem' })
const errorCls = css({ color: 'status.danger', fontSize: '0.75rem' })
const colorDialogHeaderCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '1rem 1.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const colorDialogTitleCls = css({ margin: 0, fontSize: '1rem' })
const colorDialogBodyCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1.25rem',
})
