import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { StateHint } from '@/components/StateHint'
import { Button, Switch } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  PatchTaskSettingsPayload,
  TaskReminderMinutes,
} from '../api/ApiTask'
import { useTaskSettings, useUpdateTaskSettings } from '../api/fetchTasks'

const reminderOptions: TaskReminderMinutes[] = [900, 360, 2340, 3780, 5220]

/** Task preferences embedded in the shared system-settings dialog. */
export const TaskSettingsPanel = () => {
  const { t } = useTranslation('tasks')
  const { data: settings, isLoading, error, refetch } = useTaskSettings()
  const update = useUpdateTaskSettings()
  const change = (patch: PatchTaskSettingsPayload) => update.mutate(patch)

  if (isLoading) {
    return <StateHint state="loading">{t('settings.loading')}</StateHint>
  }

  if (error || !settings) {
    return (
      <StateHint
        state="error"
        action={
          <Button
            variant="secondary"
            size="dense"
            onPress={() => void refetch()}
          >
            {t('settings.retry')}
          </Button>
        }
      >
        {t('settings.loadError')}
      </StateHint>
    )
  }

  return (
    <div className={contentCss}>
      <SettingRow
        title={t('settings.overdueMarker')}
        description={t('settings.overdueMarkerDescription')}
        control={
          <Switch
            aria-label={t('settings.overdueMarker')}
            isSelected={settings.overdue_marker_enabled}
            isDisabled={update.isPending}
            onChange={(selected) =>
              change({ overdue_marker_enabled: selected })
            }
          />
        }
      />
      <SettingRow
        title={t('settings.defaultReminder')}
        description={t('settings.defaultReminderDescription')}
        control={
          <Select
            aria-label={t('settings.defaultReminder')}
            className={selectCss}
            items={[
              {
                value: 'none',
                label: t('settings.reminderOptions.none'),
              },
              ...reminderOptions.map((minutes) => ({
                value: String(minutes),
                label: t(`settings.reminderOptions.${minutes}`),
              })),
            ]}
            selectedKey={
              settings.daily_reminder_enabled
                ? String(settings.default_reminder_minutes)
                : 'none'
            }
            isDisabled={update.isPending}
            onSelectionChange={(key) => {
              const value = String(key)
              change(
                value === 'none'
                  ? { daily_reminder_enabled: false }
                  : {
                      daily_reminder_enabled: true,
                      default_reminder_minutes: Number(
                        value
                      ) as TaskReminderMinutes,
                    }
              )
            }}
          />
        }
      />
      {update.error && (
        <p role="alert" className={saveErrorCss}>
          {t('settings.saveError')}
        </p>
      )}
    </div>
  )
}

const SettingRow = ({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: ReactNode
}) => (
  <div className={rowCss}>
    <div className={copyCss}>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    {control}
  </div>
)

const contentCss = css({
  display: 'flex',
  flexDirection: 'column',
})
const rowCss = css({
  minHeight: '5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1.5rem',
  paddingY: '1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  _last: { borderBottom: 0 },
})
const copyCss = css({
  minWidth: 0,
  '& h3': {
    margin: 0,
    color: 'default.text',
    fontSize: '0.875rem',
    fontWeight: '600',
  },
  '& p': {
    margin: '0.25rem 0 0',
    color: 'default.subtle-text',
    fontSize: '0.75rem',
    lineHeight: '1.4',
  },
})
const selectCss = css({
  flexShrink: 0,
  minWidth: '9.5rem',
})
const saveErrorCss = css({
  margin: '0.75rem 0 0',
  color: 'danger.600',
  fontSize: '0.8125rem',
})
