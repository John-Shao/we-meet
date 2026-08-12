import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSnapshot } from 'valtio'
import { useQueryClient } from '@tanstack/react-query'
import {
  RiCalendarTodoLine,
  RiCloseLine,
  RiComputerLine,
  RiFileList3Line,
  RiMoonLine,
  RiPencilLine,
  RiSettings3Line,
  RiSunLine,
  RiUser3Line,
  RiVidiconLine,
} from '@remixicon/react'
import type { RemixiconComponentType } from '@remixicon/react'

import { css, cx } from '@/styled-system/css'
import { useLanguageLabels } from '@/i18n/useLanguageLabels'
import { Button, type DialogProps } from '@/primitives'
import { Switch } from '@/primitives/Switch'
import { selectChrome } from '@/primitives/selectChrome'
import { useUser } from '@/features/auth'
import { updateEmail, updateNickname } from '@/features/auth/api/updateProfile'
import { keys } from '@/api/queryKeys'
import { LoginButton } from '@/components/LoginButton'
import { Modal } from '@/components/Modal'
import { routes } from '@/routes'
import { themeStore, type ThemeMode } from '@/stores/theme'
import type { SystemSettingsSection } from '@/stores/systemSettings'
import { userChoicesStore, VIDEO_PUBLISH_CODECS } from '@/stores/userChoices'
import type { VideoCodec } from 'livekit-client'
import {
  DURATION_OPTIONS,
  REMINDER_OPTIONS,
  reminderOptionLabel,
  useCalendarSettings,
  useSyncCalendarSettings,
  type CalendarTimezoneMode,
  type WeekStartPref,
} from '@/features/calendar/hooks/useCalendarSettings'
import {
  MAX_WORKING_DURATION_MIN,
  MIN_WORKING_DURATION_MIN,
  WORKING_TIME_OPTIONS,
  formatMinutes,
  isValidWorkingHours,
  type TimeRangeMode,
} from '@/features/calendar/utils/workingHours'
import { useReminderEntryEnabled } from '@/features/im/hooks/useReminderEntry'
import { buildTimezoneOptions } from '@/utils/timezoneOptions'
import { AvatarUploadDialog } from './AvatarUploadDialog'

export type SettingsDialogProps = Pick<
  DialogProps,
  'isOpen' | 'onOpenChange'
> & {
  /** P8 设置收敛:模块快捷入口指定打开时定位到的节(如日历页齿轮 → 'calendar')。 */
  initialSection?: SystemSettingsSection
}

type Section = SystemSettingsSection

export const SettingsDialog = ({
  isOpen,
  onOpenChange,
  initialSection,
}: SettingsDialogProps) => {
  const { t } = useTranslation('settings')
  const { isLoggedIn } = useUser()
  const [section, setSection] = useState<Section>('general')
  const [avatarOpen, setAvatarOpen] = useState(false)

  // 快捷入口带节打开时定位;不带节保持上次/默认。
  useEffect(() => {
    if (initialSection) setSection(initialSection)
  }, [initialSection])

  if (!isOpen) return null

  const navItems: Array<{
    key: Section
    label: string
    Icon: RemixiconComponentType
  }> = [
    {
      key: 'general',
      label: t('systemSettings.nav.general'),
      Icon: RiSettings3Line,
    },
    {
      key: 'account',
      label: t('systemSettings.nav.account'),
      Icon: RiUser3Line,
    },
    {
      key: 'meeting',
      label: t('systemSettings.nav.meeting'),
      Icon: RiVidiconLine,
    },
    {
      key: 'calendar',
      label: t('systemSettings.nav.calendar'),
      Icon: RiCalendarTodoLine,
    },
    {
      key: 'agreement',
      label: t('systemSettings.nav.agreement'),
      Icon: RiFileList3Line,
    },
  ]

  return (
    <Modal
      onClose={() => onOpenChange?.(false)}
      ariaLabel={t('systemSettings.heading')}
      maxWidth="760px"
      maxHeight="560px"
    >
      <div className={headerCls}>
        <h2 className={headerTitleCls}>{t('systemSettings.heading')}</h2>
        <button
          type="button"
          onClick={() => onOpenChange?.(false)}
          aria-label={t('account.avatar.cancel')}
          className={closeCls}
        >
          <RiCloseLine size={20} />
        </button>
      </div>

      <div className={bodyCls}>
        <nav className={navCls}>
          {navItems.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              aria-current={section === key}
              className={cx(
                navItemCls,
                section === key ? navItemActiveCls : navItemIdleCls
              )}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className={panelCls}>
          {section === 'general' && <GeneralPanel />}
          {section === 'account' && (
            <AccountPanel
              isLoggedIn={!!isLoggedIn}
              onEditAvatar={() => setAvatarOpen(true)}
            />
          )}
          {section === 'meeting' && <MeetingPanel />}
          {section === 'calendar' && <CalendarPanel />}
          {section === 'agreement' && <AgreementPanel />}
        </section>
      </div>

      {avatarOpen && (
        <AvatarUploadDialog onClose={() => setAvatarOpen(false)} />
      )}
    </Modal>
  )
}

/* ─── 通用设置:主题 + 语言 ─────────────────────────────────────────── */
const GeneralPanel = () => {
  const { t } = useTranslation('settings')
  const { mode } = useSnapshot(themeStore)
  const { languagesList, currentLanguage } = useLanguageLabels()
  const { i18n } = useTranslation()

  const themes: Array<{
    key: ThemeMode
    label: string
    Icon: RemixiconComponentType
  }> = [
    { key: 'light', label: t('systemSettings.theme.light'), Icon: RiSunLine },
    { key: 'dark', label: t('systemSettings.theme.dark'), Icon: RiMoonLine },
    {
      key: 'system',
      label: t('systemSettings.theme.system'),
      Icon: RiComputerLine,
    },
  ]

  return (
    <>
      <div className={fieldLabelCls}>{t('systemSettings.theme.heading')}</div>
      <div className={themeGridCls}>
        {themes.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              themeStore.mode = key
            }}
            aria-pressed={mode === key}
            className={cx(
              themeCardCls,
              mode === key ? themeCardActiveCls : themeCardIdleCls
            )}
          >
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className={rowCls}>
        <span className={fieldLabelCls}>{t('language.heading')}</span>
        <select
          value={currentLanguage.key}
          onChange={(e) => void i18n.changeLanguage(e.target.value)}
          aria-label={t('language.label')}
          className={selectCls}
        >
          {languagesList.map((l) => (
            <option key={l.key} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

/* ─── 会议设置(P8,对齐 App 端:视频编解码)───────────────────────────── */
const MeetingPanel = () => {
  const { t } = useTranslation('settings')
  const { videoPublishCodec } = useSnapshot(userChoicesStore)

  const codecLabel = (codec: VideoCodec): string => {
    const name = codec === 'h264' ? 'H.264' : codec.toUpperCase()
    return codec === 'vp9'
      ? `${name} ${t('systemSettings.meeting.defaultSuffix')}`
      : name
  }

  return (
    <div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>
          {t('systemSettings.meeting.videoCodec')}
        </span>
        <select
          value={videoPublishCodec ?? 'vp9'}
          onChange={(e) => {
            userChoicesStore.videoPublishCodec = e.target.value as VideoCodec
          }}
          aria-label={t('systemSettings.meeting.videoCodec')}
          data-testid="meeting-settings-codec"
          className={selectCls}
        >
          {VIDEO_PUBLISH_CODECS.map((codec) => (
            <option key={codec} value={codec}>
              {codecLabel(codec)}
            </option>
          ))}
        </select>
      </div>
      <p
        className={css({
          marginTop: '0.75rem',
          fontSize: '0.8125rem',
          color: 'greyscale.500',
        })}
      >
        {t('systemSettings.meeting.codecHint')}
      </p>
    </div>
  )
}

/* ─── 日历设置(P8,对标飞书可落地子集,纯 localStorage)──────────────── */
const CalendarPanel = () => {
  useSyncCalendarSettings()
  const { t, i18n } = useTranslation('calendar')
  const [reminderOn, setReminderOn] = useReminderEntryEnabled()
  const {
    weekStart,
    defaultDurationMin,
    defaultReminderMin,
    dimPast,
    showWeekend,
    workingHours,
    calendarTimeRangeMode,
    meetingRoomsTimeRangeMode,
    timezoneMode,
    fixedTimezone,
    setWeekStart,
    setDefaultDuration,
    setDefaultReminder,
    setDimPast,
    setShowWeekend,
    setWorkingHours,
    setCalendarTimeRangeMode,
    setMeetingRoomsTimeRangeMode,
    setTimezoneMode,
    setFixedTimezone,
  } = useCalendarSettings()
  const timezoneOptions = useMemo(
    () => buildTimezoneOptions(i18n.language),
    [i18n.language]
  )

  const changeWorkStart = (startMin: number) => {
    const currentDuration = workingHours.endMin - workingHours.startMin
    const endMin = Math.min(
      24 * 60,
      startMin +
        Math.min(
          MAX_WORKING_DURATION_MIN,
          Math.max(MIN_WORKING_DURATION_MIN, currentDuration)
        )
    )
    setWorkingHours(startMin, endMin)
  }

  return (
    <div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('settings.timezone')}</span>
        <select
          value={timezoneMode}
          onChange={(event) =>
            setTimezoneMode(event.target.value as CalendarTimezoneMode)
          }
          data-testid="calendar-settings-timezone-mode"
          className={selectCls}
        >
          <option value="auto">{t('settings.timezoneAuto')}</option>
          <option value="fixed">{t('settings.timezoneFixed')}</option>
        </select>
      </div>
      {timezoneMode === 'fixed' && (
        <div className={infoRowCls}>
          <span className={infoKeyCls}>{t('settings.fixedTimezone')}</span>
          <select
            value={fixedTimezone}
            onChange={(event) => setFixedTimezone(event.target.value)}
            data-testid="calendar-settings-timezone"
            className={selectCls}
          >
            {!timezoneOptions.some(
              (option) => option.zone === fixedTimezone
            ) && <option value={fixedTimezone}>{fixedTimezone}</option>}
            {timezoneOptions.map((option) => (
              <option key={option.zone} value={option.zone}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* 布尔偏好用开关(对标飞书),整行可点;标签作为 Switch 子节点 →
          自带 label 关联,比裸 checkbox 命中区大、语义更清。 */}
      <div className={infoRowCls}>
        <Switch
          isSelected={reminderOn}
          onChange={setReminderOn}
          data-testid="calendar-settings-reminder"
          className={switchRowCls}
        >
          <span className={infoKeyCls}>{t('settings.reminderEntry')}</span>
        </Switch>
      </div>
      <div className={infoRowCls}>
        <Switch
          isSelected={dimPast}
          onChange={setDimPast}
          data-testid="calendar-settings-dim-past"
          className={switchRowCls}
        >
          <span className={infoKeyCls}>{t('settings.dimPast')}</span>
        </Switch>
      </div>
      <div
        className={cx(
          infoRowCls,
          css({ borderBottom: 'none', paddingBottom: '0.375rem' })
        )}
      >
        <span className={infoKeyCls}>{t('settings.workingHours')}</span>
        <div
          className={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          })}
        >
          <select
            value={workingHours.startMin}
            onChange={(e) => changeWorkStart(Number(e.target.value))}
            aria-label={t('settings.workStart')}
            data-testid="calendar-settings-work-start"
            className={selectCls}
          >
            {WORKING_TIME_OPTIONS.slice(0, -1).map((min) => (
              <option
                key={min}
                value={min}
                disabled={min > 24 * 60 - MIN_WORKING_DURATION_MIN}
              >
                {formatMinutes(min)}
              </option>
            ))}
          </select>
          <span className={css({ color: 'greyscale.500' })}>–</span>
          <select
            value={workingHours.endMin}
            onChange={(e) =>
              setWorkingHours(workingHours.startMin, Number(e.target.value))
            }
            aria-label={t('settings.workEnd')}
            data-testid="calendar-settings-work-end"
            className={selectCls}
          >
            {WORKING_TIME_OPTIONS.slice(1).map((min) => (
              <option
                key={min}
                value={min}
                disabled={
                  !isValidWorkingHours({
                    startMin: workingHours.startMin,
                    endMin: min,
                  })
                }
              >
                {formatMinutes(min)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p
        className={css({
          margin: 0,
          paddingBottom: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.100)',
          fontSize: '0.75rem',
          color: 'greyscale.500',
        })}
      >
        {t('settings.workingHoursHint')}
      </p>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('settings.calendarTimeRange')}</span>
        <select
          value={calendarTimeRangeMode}
          onChange={(e) =>
            setCalendarTimeRangeMode(e.target.value as TimeRangeMode)
          }
          aria-label={t('settings.calendarTimeRange')}
          data-testid="calendar-settings-calendar-time-range"
          className={selectCls}
        >
          <option value="work">{t('grid.workTime')}</option>
          <option value="full">{t('grid.fullDay')}</option>
        </select>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>
          {t('settings.meetingRoomsTimeRange')}
        </span>
        <select
          value={meetingRoomsTimeRangeMode}
          onChange={(e) =>
            setMeetingRoomsTimeRangeMode(e.target.value as TimeRangeMode)
          }
          aria-label={t('settings.meetingRoomsTimeRange')}
          data-testid="calendar-settings-meeting-rooms-time-range"
          className={selectCls}
        >
          <option value="work">{t('grid.workTime')}</option>
          <option value="full">{t('grid.fullDay')}</option>
        </select>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('settings.weekStart')}</span>
        <select
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value as WeekStartPref)}
          aria-label={t('settings.weekStart')}
          data-testid="calendar-settings-week-start"
          className={selectCls}
        >
          <option value="mon">{t('settings.weekStartMon')}</option>
          <option value="sun">{t('settings.weekStartSun')}</option>
        </select>
      </div>
      <div className={infoRowCls}>
        <Switch
          isSelected={showWeekend}
          onChange={setShowWeekend}
          data-testid="calendar-settings-show-weekend"
          className={switchRowCls}
        >
          <span className={infoKeyCls}>{t('settings.showWeekend')}</span>
        </Switch>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('settings.defaultDuration')}</span>
        <select
          value={defaultDurationMin}
          onChange={(e) => setDefaultDuration(Number(e.target.value))}
          aria-label={t('settings.defaultDuration')}
          data-testid="calendar-settings-duration"
          className={selectCls}
        >
          {DURATION_OPTIONS.map((min) => (
            <option key={min} value={min}>
              {t('settings.minutes', { count: min })}
            </option>
          ))}
        </select>
      </div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('settings.defaultReminder')}</span>
        <select
          value={defaultReminderMin ?? 'none'}
          onChange={(e) =>
            setDefaultReminder(
              e.target.value === 'none' ? null : Number(e.target.value)
            )
          }
          aria-label={t('settings.defaultReminder')}
          data-testid="calendar-settings-reminder-min"
          className={selectCls}
        >
          <option value="none">{t('form.reminderNone')}</option>
          {REMINDER_OPTIONS.map((min) => (
            <option key={min} value={min}>
              {reminderOptionLabel(t, min)}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ─── 账号管理:头像 + 用户名 + 邮箱(只放已有字段)───────────────────── */
const AccountPanel = ({
  isLoggedIn,
  onEditAvatar,
}: {
  isLoggedIn: boolean
  onEditAvatar: () => void
}) => {
  const { t } = useTranslation('settings')
  const { user } = useUser()
  const qc = useQueryClient()

  if (!isLoggedIn) {
    return (
      <div
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        })}
      >
        <p className={css({ color: 'greyscale.700' })}>
          {t('account.youAreNotLoggedIn')}
        </p>
        <LoginButton />
      </div>
    )
  }

  const initial = (user?.full_name || user?.email || '?')
    .slice(0, 1)
    .toUpperCase()
  const refreshUser = () => qc.invalidateQueries({ queryKey: [keys.user] })

  return (
    <div>
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{t('systemSettings.account.avatar')}</span>
        <button
          type="button"
          onClick={onEditAvatar}
          aria-label={t('account.avatar.change')}
          className={avatarBtnCls}
        >
          {user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className={avatarImgCls} />
          ) : (
            <span className={avatarFallbackCls}>{initial}</span>
          )}
        </button>
      </div>
      <EditableRow
        label={t('systemSettings.account.username')}
        value={user?.full_name ?? ''}
        placeholder={t('systemSettings.account.notSet')}
        validate={(v) =>
          v.trim() ? '' : t('systemSettings.account.usernameRequired')
        }
        onSave={async (v) => {
          await updateNickname(v.trim())
          await refreshUser()
        }}
      />
      <EditableRow
        label={t('systemSettings.account.email')}
        value={user?.email ?? ''}
        placeholder={t('systemSettings.account.notSet')}
        inputType="email"
        validate={(v) =>
          !v.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
            ? ''
            : t('systemSettings.account.emailInvalid')
        }
        onSave={async (v) => {
          await updateEmail(v.trim())
          await refreshUser()
        }}
      />
    </div>
  )
}

/* 单行可编辑字段:点铅笔进入编辑,保存走 onSave(乐观由 invalidate 兜底)。 */
const EditableRow = ({
  label,
  value,
  placeholder,
  inputType = 'text',
  validate,
  onSave,
}: {
  label: string
  value: string
  placeholder: string
  inputType?: 'text' | 'email'
  validate?: (v: string) => string
  onSave: (v: string) => Promise<void>
}) => {
  const { t } = useTranslation('settings')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const startEdit = () => {
    setDraft(value)
    setError('')
    setEditing(true)
  }

  const submit = async () => {
    if (busy) return
    const validationError = validate?.(draft) ?? ''
    if (validationError) {
      setError(validationError)
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSave(draft)
      setEditing(false)
    } catch (e) {
      setError(extractApiError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className={infoRowCls}>
        <span className={infoKeyCls}>{label}</span>
        <button
          type="button"
          onClick={startEdit}
          aria-label={t('systemSettings.account.edit', { field: label })}
          className={editTriggerCls}
        >
          <span className={infoValCls}>{value || placeholder}</span>
          <RiPencilLine size={16} className={pencilCls} />
        </button>
      </div>
    )
  }

  return (
    <div className={editRowCls}>
      <div className={editHeadCls}>
        <span className={infoKeyCls}>{label}</span>
        <div className={editControlsCls}>
          <input
            type={inputType}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') setEditing(false)
            }}
            className={editInputCls}
          />
          {/* flexShrink:0 —— 同排的输入框是 flex:1,窄窗口下会把按钮压扁。 */}
          <Button
            variant="secondary"
            size="dense"
            onPress={() => setEditing(false)}
            className={noShrinkCls}
          >
            {t('systemSettings.account.cancel')}
          </Button>
          <Button
            variant="primary"
            size="dense"
            onPress={() => void submit()}
            isDisabled={busy}
            className={noShrinkCls}
          >
            {busy
              ? t('systemSettings.account.saving')
              : t('systemSettings.account.save')}
          </Button>
        </div>
      </div>
      {error && <span className={editErrorCls}>{error}</span>}
    </div>
  )
}

/** Pull the server's friendly message out of an ApiError body, else fall back. */
const extractApiError = (e: unknown): string => {
  const body = (e as { body?: unknown })?.body
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.error === 'string') return b.error
    // DRF field error: { email: ["…"] } / { nickname: ["…"] }
    for (const v of Object.values(b)) {
      if (typeof v === 'string') return v
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    }
  }
  return e instanceof Error ? e.message : String(e)
}

/* ─── 服务协议:用户协议 + 隐私政策 ─────────────────────────────────── */
const AgreementPanel = () => {
  const { t } = useTranslation('settings')
  const links: Array<{ label: string; href: string }> = [
    {
      label: t('systemSettings.agreement.userAgreement'),
      href: routes.termsOfService.path as string,
    },
    {
      label: t('systemSettings.agreement.privacy'),
      href: routes.legalTerms.path as string,
    },
  ]
  return (
    <div>
      {links.map((l) => (
        <div key={l.href} className={infoRowCls}>
          <span className={infoValCls}>{l.label}</span>
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className={viewBtnCls}
          >
            {t('systemSettings.agreement.view')}
          </a>
        </div>
      ))}
    </div>
  )
}

/* ─── styles ────────────────────────────────────────────────────────── */
const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.5rem',
  paddingY: '1rem',
})
const headerTitleCls = css({
  margin: 0,
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.1000',
})
const closeCls = css({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.600',
  display: 'inline-flex',
  _hover: { color: 'greyscale.900' },
})
const bodyCls = css({
  display: 'flex',
  flex: 1,
  minHeight: '22rem',
  overflow: 'hidden',
})
const navCls = css({
  flexShrink: 0,
  width: '11rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.5rem 0.75rem',
})
// 布局与状态背景拆开:cx 叠加同属性原子类按样式表顺序取胜,active 的
// backgroundColor 曾与基类的 background 简写互撞靠顺序侥幸生效
// (memory: panda-cx-atomic-order-trap)。
const navItemCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: 'none',
  borderRadius: '0.5rem',
  color: 'greyscale.800',
  fontSize: '0.9375rem',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
const navItemIdleCls = css({ backgroundColor: 'transparent' })
const navItemActiveCls = css({
  backgroundColor: 'greyscale.100',
  fontWeight: 'medium',
})
const panelCls = css({
  flex: 1,
  minWidth: 0,
  padding: '1.25rem 1.5rem',
  overflowY: 'auto',
})
const fieldLabelCls = css({
  fontSize: '0.9375rem',
  color: 'greyscale.900',
  marginBottom: '0.625rem',
})
const themeGridCls = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '0.75rem',
  marginBottom: '1.5rem',
})
// 同上:边框/背景/文字色全部下放到状态类,基类只留布局(零属性交集)。
const themeCardCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  paddingY: '1.25rem',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
})
const themeCardIdleCls = css({
  borderColor: 'greyscale.300',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  _hover: { borderColor: 'primary.400' },
})
const themeCardActiveCls = css({
  borderColor: 'brand.500',
  backgroundColor: 'brand.50',
  color: 'brand.700',
})
const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
})
const selectCls = cx(
  css({
    minWidth: '10rem',
    paddingX: '0.875rem',
    paddingY: '0.5rem',
    border: '1px solid token(colors.greyscale.300)',
    // 标准:表单控件用 8px 圆角,不用胶囊(胶囊只留搜索框/chip/头像)。
    borderRadius: '0.5rem',
    backgroundColor: 'greyscale.000',
    color: 'greyscale.900',
    fontSize: '0.875rem',
    cursor: 'pointer',
    outline: 'none',
    _focus: { borderColor: 'primary.500' },
  }),
  selectChrome
)
const infoRowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingY: '1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const infoKeyCls = css({ fontSize: '0.9375rem', color: 'greyscale.800' })
// Switch 撑满整行:标签(子节点)在左、开关在右,整行可点。
const switchRowCls = css({
  width: '100%',
  flexDirection: 'row-reverse',
  justifyContent: 'space-between',
})
const infoValCls = css({ fontSize: '0.9375rem', color: 'greyscale.900' })
const editTriggerCls = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  maxWidth: '70%',
  _hover: { '& svg': { color: 'primary.600' } },
})
const pencilCls = css({ color: 'greyscale.500', flexShrink: 0 })
const editRowCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  paddingY: '1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const editHeadCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
})
const editControlsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flex: 1,
  justifyContent: 'flex-end',
})
// 与同一弹窗里的语言/时区下拉(selectCls → selectChrome)对齐到 control.md;
// 钉高就得去掉上下内边距,否则文字被切,见 primitives/selectChrome 的注释。
const editInputCls = css({
  flex: 1,
  maxWidth: '18rem',
  height: 'control.md',
  paddingX: '0.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.900',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})
const noShrinkCls = css({ flexShrink: 0 })
const editErrorCls = css({ fontSize: '0.8125rem', color: 'danger.600' })
const avatarBtnCls = css({
  width: '2.5rem',
  height: '2.5rem',
  borderRadius: '0.5rem',
  border: 'none',
  padding: 0,
  overflow: 'hidden',
  cursor: 'pointer',
  flexShrink: 0,
})
const avatarImgCls = css({ width: '100%', height: '100%', objectFit: 'cover' })
const avatarFallbackCls = css({
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'primary.500',
  color: 'white',
  fontSize: '1rem',
})
const viewBtnCls = css({
  paddingX: '1.25rem',
  paddingY: '0.4375rem',
  border: '1px solid token(colors.greyscale.300)',
  // 标准:动作按钮 8px 圆角,不用胶囊。
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.800',
  fontSize: '0.875rem',
  textDecoration: 'none',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})
