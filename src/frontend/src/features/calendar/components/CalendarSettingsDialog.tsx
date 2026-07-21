import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useReminderEntryEnabled } from '@/features/im/hooks/useReminderEntry'

import {
  DURATION_OPTIONS,
  REMINDER_OPTIONS,
  useCalendarSettings,
  type WeekStartPref,
} from '../hooks/useCalendarSettings'

/**
 * P8 日历设置弹窗(对标飞书日历设置页的 we-meet 可落地子集):
 * - 在消息列表提醒日程(与 IM 列表入口/日程提醒页开关同一存储——入口被
 *   关掉后,这里是唯一还能找到的重开入口,解死锁);
 * - 每周的第一天(周一/周日,作用于主网格+迷你月历);
 * - 日程默认时长(新建表单的默认结束时间);
 * - 默认提醒时间(新建表单预勾的提前量;既有日程不受影响)。
 * 全部纯客户端 localStorage,即改即生效。
 */
export const CalendarSettingsDialog = ({
  onClose,
}: {
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')
  const [reminderOn, setReminderOn] = useReminderEntryEnabled()
  const {
    weekStart,
    defaultDurationMin,
    defaultReminderMin,
    setWeekStart,
    setDefaultDuration,
    setDefaultReminder,
  } = useCalendarSettings()

  return (
    <Modal onClose={onClose} ariaLabel={t('settings.title')} maxWidth="380px">
      <div className={css({ padding: '1.25rem' })}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('settings.title')}
        </h2>

        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.875rem',
            marginTop: '1rem',
          })}
        >
          <label className={settingRow}>
            <span className={settingLabel}>{t('settings.reminderEntry')}</span>
            <input
              type="checkbox"
              checked={reminderOn}
              onChange={(e) => setReminderOn(e.target.checked)}
              data-testid="calendar-settings-reminder"
            />
          </label>

          <label className={settingRow}>
            <span className={settingLabel}>{t('settings.weekStart')}</span>
            <select
              value={weekStart}
              onChange={(e) => setWeekStart(e.target.value as WeekStartPref)}
              data-testid="calendar-settings-week-start"
              className={settingSelect}
            >
              <option value="mon">{t('settings.weekStartMon')}</option>
              <option value="sun">{t('settings.weekStartSun')}</option>
            </select>
          </label>

          <label className={settingRow}>
            <span className={settingLabel}>
              {t('settings.defaultDuration')}
            </span>
            <select
              value={defaultDurationMin}
              onChange={(e) => setDefaultDuration(Number(e.target.value))}
              data-testid="calendar-settings-duration"
              className={settingSelect}
            >
              {DURATION_OPTIONS.map((min) => (
                <option key={min} value={min}>
                  {t('settings.minutes', { count: min })}
                </option>
              ))}
            </select>
          </label>

          <label className={settingRow}>
            <span className={settingLabel}>
              {t('settings.defaultReminder')}
            </span>
            <select
              value={defaultReminderMin ?? 'none'}
              onChange={(e) =>
                setDefaultReminder(
                  e.target.value === 'none' ? null : Number(e.target.value)
                )
              }
              data-testid="calendar-settings-reminder-min"
              className={settingSelect}
            >
              <option value="none">{t('form.reminderNone')}</option>
              {REMINDER_OPTIONS.map((min) => (
                <option key={min} value={min}>
                  {t('form.reminderMinutes', { count: min })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: '1.25rem',
          })}
        >
          <button
            type="button"
            onClick={onClose}
            data-testid="calendar-settings-close"
            className={css({
              paddingX: '0.875rem',
              paddingY: '0.4375rem',
              border: '1px solid token(colors.greyscale.300)',
              borderRadius: '0.5rem',
              backgroundColor: 'greyscale.000',
              color: 'greyscale.700',
              fontSize: '0.8125rem',
              cursor: 'pointer',
            })}
          >
            {t('settings.close')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

const settingRow = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  cursor: 'pointer',
})

const settingLabel = css({
  fontSize: '0.875rem',
  color: 'greyscale.800',
})

const settingSelect = css({
  paddingX: '0.5rem',
  paddingY: '0.25rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  fontSize: '0.8125rem',
})
