import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { Button, Switch } from '@/primitives'
import { css } from '@/styled-system/css'

import type { PatchTaskSettingsPayload } from '../api/ApiTask'
import { useTaskSettings, useUpdateTaskSettings } from '../api/fetchTasks'

const reminderOptions = [30, 60, 1440] as const

export const TaskSettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation('tasks')
  const { data: settings, isLoading, error, refetch } = useTaskSettings()
  const update = useUpdateTaskSettings()
  const change = (patch: PatchTaskSettingsPayload) => update.mutate(patch)

  return (
    <Modal ariaLabel={t('settings.title')} onClose={onClose} maxWidth="520px">
      <div className={headerCss}>
        <h2 className={titleCss}>{t('settings.title')}</h2>
        <ModalCloseButton label={t('settings.close')} onClose={onClose} />
      </div>
      {isLoading ? (
        <StateHint loading>{t('settings.loading')}</StateHint>
      ) : error || !settings ? (
        <div className={loadErrorCss}>
          <p role="alert">{t('settings.loadError')}</p>
          <Button
            variant="secondary"
            size="dense"
            onPress={() => void refetch()}
          >
            {t('settings.retry')}
          </Button>
        </div>
      ) : (
        <div className={contentCss}>
          <SettingRow
            title={t('settings.dailyReminder')}
            description={t('settings.dailyReminderDescription')}
            control={
              <Switch
                aria-label={t('settings.dailyReminder')}
                isSelected={settings.daily_reminder_enabled}
                isDisabled={update.isPending}
                onChange={(selected) =>
                  change({ daily_reminder_enabled: selected })
                }
              />
            }
          />
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
              <select
                aria-label={t('settings.defaultReminder')}
                className={selectCss}
                value={settings.default_reminder_minutes}
                disabled={update.isPending}
                onChange={(event) =>
                  change({
                    default_reminder_minutes: Number(event.target.value) as
                      | 30
                      | 60
                      | 1440,
                  })
                }
              >
                {reminderOptions.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t(`settings.reminderOptions.${minutes}`)}
                  </option>
                ))}
              </select>
            }
          />
          {update.error && (
            <p role="alert" className={saveErrorCss}>
              {t('settings.saveError')}
            </p>
          )}
        </div>
      )}
    </Modal>
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

const headerCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCss = css({
  margin: 0,
  color: 'default.text',
  fontSize: '1rem',
})
const contentCss = css({
  display: 'flex',
  flexDirection: 'column',
  padding: '0.5rem 1rem 1rem',
})
const rowCss = css({
  minHeight: '5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1.5rem',
  paddingY: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
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
  height: '2.25rem',
  paddingX: '0.625rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.000',
  color: 'default.text',
  fontSize: '0.8125rem',
  _focusVisible: {
    outline: '2px solid token(colors.focusRing)',
    outlineOffset: '2px',
  },
  _disabled: { opacity: 0.5, cursor: 'default' },
})
const loadErrorCss = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '2rem',
  color: 'default.subtle-text',
  fontSize: '0.875rem',
  '& p': { margin: 0 },
})
const saveErrorCss = css({
  margin: '0.75rem 0 0',
  color: 'danger.600',
  fontSize: '0.8125rem',
})
