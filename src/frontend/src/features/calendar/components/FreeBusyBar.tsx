import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'

import { fetchFreeBusy } from '../api/fetchCalendar'

/**
 * P2-M3 忙闲视图(CreateEventDialog 内嵌):选完与会人后,按「事件所在的
 * 本地日 00:00–24:00」拉每人 busy 区间,横向时间条一人一行;与所选时段
 * 冲突的人标红提示,但**不阻断**创建(doc 口径)。
 */
export const FreeBusyBar = ({
  people,
  slotStart,
  slotEnd,
}: {
  /** 需要展示的人(含发起人自己);label 已解析好。 */
  people: { id: string; label: string }[]
  slotStart: Date
  slotEnd: Date
}) => {
  const { t } = useTranslation('calendar')
  // 窗口 = 所选开始时刻当天的本地 00:00 → 次日 00:00。
  const dayStart = new Date(slotStart)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const ids = people.map((p) => p.id)
  const { data: entries = [] } = useQuery({
    queryKey: [
      'calendar',
      'freebusy',
      ids.slice().sort().join(','),
      dayStart.toISOString(),
    ],
    queryFn: () => fetchFreeBusy(ids, dayStart.toISOString(), dayEnd.toISOString()),
    enabled: ids.length > 0,
    staleTime: 30_000,
  })

  const total = dayEnd.getTime() - dayStart.getTime()
  const pct = (d: Date | string) => {
    const ts = typeof d === 'string' ? new Date(d).getTime() : d.getTime()
    return Math.min(100, Math.max(0, ((ts - dayStart.getTime()) / total) * 100))
  }
  const slotLeft = pct(slotStart)
  const slotWidth = Math.max(pct(slotEnd) - slotLeft, 0.5)

  const busyOf = (id: string) =>
    entries.find((e) => e.user_id === id)?.busy ?? []
  const conflicts = people.filter((p) =>
    busyOf(p.id).some(
      (b) => new Date(b.start) < slotEnd && new Date(b.end) > slotStart
    )
  )

  return (
    <div data-testid="freebusy">
      <div
        className={css({
          fontSize: '0.75rem',
          color: 'greyscale.500',
          marginBottom: '0.375rem',
        })}
      >
        {t('freebusy.title')}
      </div>
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
        })}
      >
        {people.map((person) => {
          const inConflict = conflicts.some((c) => c.id === person.id)
          return (
            <div
              key={person.id}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              })}
            >
              <span
                className={css({
                  width: '5.5rem',
                  flexShrink: 0,
                  fontSize: '0.75rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                })}
                style={inConflict ? { color: '#dc2626' } : undefined}
              >
                {person.label}
              </span>
              <div
                className={css({
                  position: 'relative',
                  flex: 1,
                  height: '0.875rem',
                  borderRadius: '4px',
                  backgroundColor: 'greyscale.100',
                  overflow: 'hidden',
                })}
              >
                {busyOf(person.id).map((b, i) => (
                  <div
                    key={i}
                    title={`${new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(b.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                    className={css({
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      backgroundColor: 'greyscale.400',
                    })}
                    style={{
                      left: `${pct(b.start)}%`,
                      width: `${Math.max(pct(b.end) - pct(b.start), 0.5)}%`,
                    }}
                  />
                ))}
                {/* 所选时段覆盖层:冲突红、正常主色。 */}
                <div
                  className={css({ position: 'absolute', top: 0, bottom: 0 })}
                  style={{
                    left: `${slotLeft}%`,
                    width: `${slotWidth}%`,
                    backgroundColor: inConflict
                      ? 'rgba(220,38,38,0.45)'
                      : 'rgba(59,130,246,0.45)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      {conflicts.length > 0 && (
        <div
          className={css({ fontSize: '0.75rem', marginTop: '0.375rem' })}
          style={{ color: '#dc2626' }}
          data-testid="freebusy-conflict"
        >
          {t('freebusy.conflict', { count: conflicts.length })}
        </div>
      )}
    </div>
  )
}
