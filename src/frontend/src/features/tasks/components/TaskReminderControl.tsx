import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type {
  PatchTaskReminderPreferencePayload,
  TaskReminderMinutes,
} from '../api/ApiTask'
import { useTaskReminder, useUpdateTaskReminder } from '../api/fetchTasks'

const reminderOptions: TaskReminderMinutes[] = [900, 360, 2340, 3780, 5220]

export const TaskReminderFields = ({
  enabled,
  reminderMinutes,
  disabled = false,
  onChange,
}: {
  enabled: boolean
  reminderMinutes: TaskReminderMinutes | null
  disabled?: boolean
  onChange: (patch: PatchTaskReminderPreferencePayload) => void
}) => {
  const { t } = useTranslation('tasks')

  return (
    <div className={controlCss}>
      <select
        aria-label={t('taskReminder.timing')}
        className={selectCss}
        value={enabled ? (reminderMinutes ?? 'default') : 'none'}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value
          onChange(
            value === 'none'
              ? { enabled: false }
              : {
                  enabled: true,
                  reminder_minutes:
                    value === 'default'
                      ? null
                      : (Number(value) as TaskReminderMinutes),
                }
          )
        }}
      >
        <option value="none">{t('settings.reminderOptions.none')}</option>
        <option value="default">{t('taskReminder.followDefault')}</option>
        {reminderOptions.map((minutes) => (
          <option key={minutes} value={minutes}>
            {t(`settings.reminderOptions.${minutes}`)}
          </option>
        ))}
      </select>
    </div>
  )
}

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
    <div>
      <TaskReminderFields
        enabled={data.enabled}
        reminderMinutes={data.reminder_minutes}
        disabled={update.isPending}
        onChange={change}
      />
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
