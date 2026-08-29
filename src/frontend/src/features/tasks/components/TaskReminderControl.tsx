import { useTranslation } from 'react-i18next'

import { Button, Switch } from '@/primitives'
import { css } from '@/styled-system/css'

import type { PatchTaskReminderPreferencePayload } from '../api/ApiTask'
import { useTaskReminder, useUpdateTaskReminder } from '../api/fetchTasks'

const reminderOptions = [0, 1440, 4320] as const

export const TaskReminderControl = ({ taskId }: { taskId: string }) => {
  const { t } = useTranslation('tasks')
  const { data, isLoading, error, refetch } = useTaskReminder(taskId)
  const update = useUpdateTaskReminder(taskId)
  const change = (patch: PatchTaskReminderPreferencePayload) =>
    update.mutate(patch)

  if (isLoading) {
    return <span className={hintCss}>{t('taskReminder.loading')}</span>
  }
  if (error || !data) {
    return (
      <span className={errorCss} role="alert">
        {t('taskReminder.loadError')}
        <Button
          variant="quaternaryText"
          size="sm"
          onPress={() => void refetch()}
        >
          {t('settings.retry')}
        </Button>
      </span>
    )
  }

  return (
    <div className={controlCss}>
      <Switch
        aria-label={t('taskReminder.enabled')}
        isSelected={data.enabled}
        isDisabled={update.isPending}
        onChange={(enabled) => change({ enabled })}
      />
      <select
        aria-label={t('taskReminder.timing')}
        className={selectCss}
        value={data.reminder_minutes ?? 'default'}
        disabled={!data.enabled || update.isPending}
        onChange={(event) =>
          change({
            reminder_minutes:
              event.target.value === 'default'
                ? null
                : (Number(event.target.value) as 0 | 1440 | 4320),
          })
        }
      >
        <option value="default">
          {t('taskReminder.followDefault', {
            value: t(
              `settings.reminderOptions.${data.effective_reminder_minutes}`
            ),
          })}
        </option>
        {reminderOptions.map((minutes) => (
          <option key={minutes} value={minutes}>
            {t(`settings.reminderOptions.${minutes}`)}
          </option>
        ))}
      </select>
      {!data.global_reminders_enabled && (
        <span className={hintCss}>{t('taskReminder.globalDisabled')}</span>
      )}
      {update.error && (
        <span className={errorCss} role="alert">
          {t('taskReminder.saveError')}
        </span>
      )}
    </div>
  )
}

const controlCss = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '0.5rem',
})
const selectCss = css({
  minWidth: '10rem',
  height: '2rem',
  paddingX: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.75rem',
  _focusVisible: {
    outline: '2px solid token(colors.focusRing)',
    outlineOffset: '2px',
  },
  _disabled: { opacity: 0.5, cursor: 'default' },
})
const hintCss = css({ color: 'default.subtle-text', fontSize: '0.75rem' })
const errorCss = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  color: 'danger.600',
  fontSize: '0.75rem',
})
