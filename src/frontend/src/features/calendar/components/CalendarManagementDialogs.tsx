import { SelectCompat } from '@/primitives/SelectCompat'
import { type ReactNode, type RefObject, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { MemberAvatar } from '@/features/contacts'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { MeetingRoomSummary } from '@/features/meeting-rooms'
import { useInlineEditFocus } from '@/hooks/useInlineEditFocus'
import { Button } from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { css, cx } from '@/styled-system/css'

import {
  addCalendarMember,
  createCalendar,
  createCalendarExport,
  deleteCalendar,
  discoverCalendars,
  fetchCalendarMembers,
  fetchCalendarShareLink,
  removeCalendarMember,
  resetCalendarShareLink,
  setCalendarSubscription,
  unsubscribeUnifiedCalendar,
  updateCalendar,
  updateCalendarMember,
  type CalendarRole,
  type UnifiedCalendar,
} from '../api/calendars'
import { CALENDAR_COLOR_PALETTE } from '../utils/calendarColors'
import {
  fieldCls,
  inputCls as eventInputCls,
  labelCls as eventLabelCls,
} from './formStyles'
import { BulkAttendeeDialog } from './BulkAttendeeDialog'
import { CalendarColorPicker } from './CalendarColorPicker'

const roleKeys: Record<
  Exclude<CalendarRole, 'none'>,
  'freeBusy' | 'details' | 'writer' | 'admin'
> = {
  free_busy: 'freeBusy',
  details: 'details',
  writer: 'writer',
  admin: 'admin',
}

type DraftCalendarMember = {
  label: string
  avatarUrl?: string
  role: Exclude<CalendarRole, 'none'>
}

const qrSvgBlob = () => {
  const svg = document.getElementById('calendar-share-qr')
  if (!(svg instanceof SVGElement)) throw new Error('QR code not generated')
  return new Blob([new XMLSerializer().serializeToString(svg)], {
    type: 'image/svg+xml;charset=utf-8',
  })
}

const downloadQrImage = (name: string) => {
  const url = URL.createObjectURL(qrSvgBlob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name}-calendar-qr.svg`
  anchor.click()
  URL.revokeObjectURL(url)
}

const copyQrImage = async () => {
  const sourceUrl = URL.createObjectURL(qrSvgBlob())
  try {
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 440
    canvas.height = 440
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Copying QR code is not supported')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error('QR code generation failed')),
        'image/png'
      )
    )
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

const DialogFrame = ({
  title,
  onClose,
  children,
  footer,
  maxWidth = '560px',
  initialFocusRef,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  maxWidth?: string
  /** 透传给 Modal:打开后第一件事就是打字的对话框应当指到那个输入框(见 Modal)。 */
  initialFocusRef?: RefObject<HTMLElement | null>
}) => {
  const { t } = useTranslation('calendar')
  return (
    <Modal
      onClose={onClose}
      ariaLabel={title}
      maxWidth={maxWidth}
      maxHeight="82vh"
      initialFocusRef={initialFocusRef}
    >
      <ModalHeader
        title={title}
        onClose={onClose}
        closeLabel={t('manage.close')}
      />
      <ModalBody>{children}</ModalBody>
      {footer ? <ModalFooter>{footer}</ModalFooter> : null}
    </Modal>
  )
}

export const AddCalendarDialog = ({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) => {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [mode, setMode] = useState<'subscribe' | 'create'>('subscribe')
  const [discoverType, setDiscoverType] = useState<
    'contact' | 'room' | 'public'
  >('contact')
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>(CALENDAR_COLOR_PALETTE[0])
  const [defaultAccess, setDefaultAccess] = useState<
    'none' | 'free_busy' | 'details'
  >('details')
  const [memberRole, setMemberRole] =
    useState<Exclude<CalendarRole, 'none'>>('details')
  const [members, setMembers] = useState<Map<string, DraftCalendarMember>>(
    new Map()
  )
  const [memberPickerOpen, setMemberPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 打开时停在「订阅日历」态,主目标就是那个搜索框 —— 交给 Modal 的初始焦点。
  const searchRef = useRef<HTMLInputElement>(null)
  // 切到「新建日历」是另一件事:名称字段这时才出现,焦点得跟过去。标签按钮本身不会
  // 卸载(点它焦点自然停在它上面),所以不需要退出时的回焦,只用 fieldRef。
  const { fieldRef: nameRef } = useInlineEditFocus(mode === 'create')
  const { data: discoveries = [], isFetching } = useQuery({
    queryKey: ['calendar', 'discover', discoverType, query],
    queryFn: () => discoverCalendars(discoverType, query),
    enabled: mode === 'subscribe',
  })

  const changed = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['calendar', 'unified'] }),
      qc.invalidateQueries({ queryKey: ['calendar', 'discover'] }),
    ])
    onChanged()
  }

  const toggleSubscription = async (calendar: UnifiedCalendar) => {
    setBusy(true)
    setError('')
    try {
      if (calendar.subscribed) {
        await unsubscribeUnifiedCalendar(calendar.id)
      } else {
        await setCalendarSubscription(calendar.id, { enabled: true })
      }
      await changed()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      await createCalendar({
        name: name.trim(),
        description,
        color,
        organization_default_access: defaultAccess,
        members: [...members.entries()].map(([user_id, member]) => ({
          user_id,
          role: member.role,
        })),
      })
      await changed()
      onClose()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const dialog = (
    <DialogFrame
      title={t('manage.addTitle')}
      onClose={onClose}
      maxWidth="680px"
      initialFocusRef={searchRef}
      footer={
        mode === 'create' ? (
          <>
            <Button variant="secondary" size="action" onPress={onClose}>
              {t('manage.cancel')}
            </Button>
            <Button
              variant="primary"
              size="action"
              isDisabled={busy || !name.trim()}
              onPress={() => void create()}
            >
              {t('manage.save')}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className={tabsCls}>
        {(
          [
            ['subscribe', t('manage.tabSubscribe')],
            ['create', t('manage.tabCreate')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={mode === value ? activeTabCls : tabCls}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'subscribe' && (
        <div className={stackCls}>
          <input
            ref={searchRef}
            className={eventInputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('manage.searchPlaceholder')}
          />
          <div className={tabsCls}>
            {(
              [
                ['contact', t('manage.discoverContact')],
                ['room', t('manage.discoverRoom')],
                ['public', t('manage.discoverPublic')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={discoverType === value ? activeTabCls : tabCls}
                onClick={() => setDiscoverType(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {isFetching && discoveries.length === 0 ? (
            <p className={mutedCls}>{t('manage.searching')}</p>
          ) : discoveries.length === 0 ? (
            <p className={mutedCls}>{t('manage.noDiscoveries')}</p>
          ) : (
            discoveries.map((calendar) => {
              const contactSupportingText = [
                calendar.owner?.title,
                calendar.owner?.department?.name,
              ]
                .filter(Boolean)
                .join(' · ')

              return (
                <div key={calendar.id} className={rowCls}>
                  {discoverType === 'contact' ? (
                    <MemberAvatar
                      name={calendar.display_name}
                      src={calendar.owner?.avatar_url}
                      size="2.25rem"
                    />
                  ) : (
                    <span
                      className={dotCls}
                      style={{ background: calendar.color }}
                    />
                  )}
                  <span className={growCls}>
                    {calendar.meeting_room ? (
                      <MeetingRoomSummary
                        room={calendar.meeting_room}
                        primaryClassName={roomNameCls}
                        secondaryClassName={mutedCls}
                      />
                    ) : (
                      <>
                        <strong>{calendar.display_name}</strong>
                        {(discoverType === 'contact'
                          ? contactSupportingText
                          : calendar.description) && (
                          <small className={mutedCls}>
                            {discoverType === 'contact'
                              ? contactSupportingText
                              : calendar.description}
                          </small>
                        )}
                      </>
                    )}
                  </span>
                  <Button
                    variant="primary"
                    size="dense"
                    isDisabled={busy}
                    onPress={() => void toggleSubscription(calendar)}
                  >
                    {calendar.subscribed
                      ? t('manage.unsubscribe')
                      : t('manage.subscribe')}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      )}
      {mode === 'create' && (
        <div className={stackCls}>
          <label className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.name')}</span>
            <input
              ref={nameRef}
              className={eventInputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.description')}</span>
            <textarea
              className={textareaCls}
              value={description}
              maxLength={400}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.color')}</span>
            <CalendarColorPicker
              value={color}
              label={t('manage.color')}
              onChange={setColor}
            />
          </div>
          <label className={fieldCls}>
            <span className={eventLabelCls}>
              {t('manage.organizationDefaultAccess')}
            </span>
            <SelectCompat
              className={cx(eventInputCls, selectChrome)}
              value={defaultAccess}
              onChange={(e) =>
                setDefaultAccess(e.target.value as typeof defaultAccess)
              }
            >
              <option value="none">{t('manage.access.none')}</option>
              <option value="free_busy">{t('manage.access.freeBusy')}</option>
              <option value="details">{t('manage.access.details')}</option>
            </SelectCompat>
          </label>
          <h3 className={sectionTitleCls}>{t('manage.sharedMembers')}</h3>
          {[...members.entries()].map(([id, member]) => (
            <div key={id} className={rowCls}>
              <MemberAvatar
                name={member.label}
                src={member.avatarUrl}
                size="2rem"
              />
              <span className={growCls}>{member.label}</span>
              <div className={memberRoleCls}>
                <RoleSelect
                  value={member.role}
                  onChange={(role) =>
                    setMembers((current) => {
                      const next = new Map(current)
                      next.set(id, { ...member, role })
                      return next
                    })
                  }
                />
              </div>
              <Button
                variant="quaternaryDanger"
                size="dense"
                onPress={() =>
                  setMembers((current) => {
                    const next = new Map(current)
                    next.delete(id)
                    return next
                  })
                }
              >
                {t('manage.remove')}
              </Button>
            </div>
          ))}
          <div className={memberAddRowCls}>
            <div className={fieldCls}>
              <span className={eventLabelCls}>{t('manage.newMemberRole')}</span>
              <RoleSelect value={memberRole} onChange={setMemberRole} />
            </div>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              onPress={() => setMemberPickerOpen(true)}
            >
              {t('manage.addSharedMember')}
            </Button>
          </div>
        </div>
      )}
      {error && <p className={errorCls}>{error}</p>}
    </DialogFrame>
  )

  if (!memberPickerOpen) return dialog

  return (
    <>
      {dialog}
      <BulkAttendeeDialog
        initial={new Map()}
        title={t('manage.addSharedMember')}
        searchPlaceholder={t('manage.searchMember')}
        selectedTitle={(count) => t('manage.selectedCount', { count })}
        confirmLabel={t('manage.add')}
        excludeIds={new Set(members.keys())}
        onClose={() => setMemberPickerOpen(false)}
        onConfirm={(selected, avatars) => {
          setMembers((current) => {
            const next = new Map(current)
            selected.forEach((label, id) => {
              next.set(id, {
                label,
                avatarUrl: avatars.get(id),
                role: memberRole,
              })
            })
            return next
          })
          setMemberPickerOpen(false)
        }}
      />
    </>
  )
}

const RoleSelect = ({
  value,
  onChange,
  readOnly = false,
  allowedRoles = ['free_busy', 'details', 'writer', 'admin'] as Exclude<
    CalendarRole,
    'none'
  >[],
}: {
  value: Exclude<CalendarRole, 'none'>
  onChange: (role: Exclude<CalendarRole, 'none'>) => void
  readOnly?: boolean
  allowedRoles?: Exclude<CalendarRole, 'none'>[]
}) => {
  const { t } = useTranslation('calendar')
  return (
    <SelectCompat
      className={cx(eventInputCls, selectChrome)}
      value={value}
      disabled={readOnly}
      onChange={(event) =>
        onChange(event.target.value as Exclude<CalendarRole, 'none'>)
      }
    >
      {allowedRoles.map((role) => (
        <option key={role} value={role}>
          {t(`manage.role.${roleKeys[role]}`)}
        </option>
      ))}
    </SelectCompat>
  )
}

export const CalendarSettingsDialog = ({
  calendar,
  onClose,
  onChanged,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
  onChanged: () => void
}) => {
  const { t } = useTranslation('calendar')
  const qc = useQueryClient()
  const [name, setName] = useState(calendar.display_name)
  // 「日历设置」是单一表单(不是多节导航面板),打开后第一件事通常就是改名 ——
  // 焦点给名称框。但**主日历的名称框是 disabled**(跟随账号名),对 disabled 元素
  // 调 focus() 是空操作,而 Modal 只要拿到非空的 initialFocusRef 就不会再退回容器
  // 兜底 —— 那样焦点会重新掉到弹窗外面。所以主日历这一档必须不传 ref。
  const nameRef = useRef<HTMLInputElement>(null)
  const nameEditable = calendar.kind !== 'primary'
  const [description, setDescription] = useState(calendar.description)
  const [defaultAccess, setDefaultAccess] = useState(
    calendar.organization_default_access
  )
  const [color, setColor] = useState(calendar.color)
  const [addRole, setAddRole] =
    useState<Exclude<CalendarRole, 'none'>>('details')
  const [memberPickerOpen, setMemberPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: members = [] } = useQuery({
    queryKey: ['calendar', calendar.id, 'members'],
    queryFn: () => fetchCalendarMembers(calendar.id),
    enabled: calendar.capabilities.can_manage,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['calendar', 'unified'] }),
      qc.invalidateQueries({ queryKey: ['calendar', calendar.id, 'members'] }),
    ])
    onChanged()
  }
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (reason) {
      setError(apiErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  const saveSettings = () =>
    act(async () => {
      await updateCalendar(calendar.id, {
        ...(calendar.kind === 'primary' ? {} : { name }),
        description,
        organization_default_access: defaultAccess,
      })
      await setCalendarSubscription(calendar.id, { color })
    })
  return (
    <>
      <DialogFrame
        title={t('manage.settingsTitle')}
        onClose={onClose}
        initialFocusRef={nameEditable ? nameRef : undefined}
        footer={
          <>
            <Button variant="secondary" size="action" onPress={onClose}>
              {t('manage.cancel')}
            </Button>
            <Button
              variant="primary"
              size="action"
              isDisabled={busy || !name.trim()}
              onPress={() => void saveSettings()}
            >
              {t('manage.save')}
            </Button>
          </>
        }
      >
        <div className={stackCls}>
          <label className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.name')}</span>
            <input
              ref={nameRef}
              className={cx(eventInputCls, disabledControlCls)}
              disabled={calendar.kind === 'primary'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {calendar.kind === 'primary' && (
              <small className={mutedCls}>{t('manage.primaryNameHint')}</small>
            )}
          </label>
          <label className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.description')}</span>
            <textarea
              className={textareaCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className={fieldCls}>
            <span className={eventLabelCls}>{t('manage.myDisplayColor')}</span>
            <CalendarColorPicker
              value={color}
              label={t('manage.myDisplayColor')}
              onChange={setColor}
            />
          </div>
          <label className={fieldCls}>
            <span className={eventLabelCls}>
              {t('manage.organizationDefaultAccess')}
            </span>
            <SelectCompat
              className={cx(eventInputCls, selectChrome)}
              value={defaultAccess}
              onChange={(e) =>
                setDefaultAccess(e.target.value as typeof defaultAccess)
              }
            >
              <option value="none">{t('manage.access.none')}</option>
              <option value="free_busy">{t('manage.access.freeBusy')}</option>
              <option value="details">{t('manage.access.details')}</option>
            </SelectCompat>
          </label>
          <p className={mutedCls}>{t('manage.externalDefaultHint')}</p>
          <h3 className={sectionTitleCls}>{t('manage.sharedMembers')}</h3>
          {members.map((member) => (
            <div key={member.id} className={rowCls}>
              <MemberAvatar
                name={
                  member.user.full_name ||
                  member.user.short_name ||
                  t('manage.unknownUser')
                }
                src={member.user.avatar_url}
                size="2rem"
              />
              <span className={growCls}>
                {member.user.full_name ||
                  member.user.short_name ||
                  t('manage.unknownUser')}
                {member.external ? t('manage.externalContact') : ''}
              </span>
              <div className={memberRoleCls}>
                <RoleSelect
                  value={member.role}
                  allowedRoles={
                    calendar.kind === 'primary' || member.external
                      ? ['free_busy', 'details']
                      : undefined
                  }
                  onChange={(role) =>
                    void act(() =>
                      updateCalendarMember(calendar.id, member.id, role)
                    )
                  }
                />
              </div>
              <Button
                variant="quaternaryDanger"
                size="dense"
                onPress={() =>
                  void act(() => removeCalendarMember(calendar.id, member.id))
                }
              >
                {t('manage.remove')}
              </Button>
            </div>
          ))}
          <div className={memberAddRowCls}>
            <div className={fieldCls}>
              <span className={eventLabelCls}>{t('manage.newMemberRole')}</span>
              <RoleSelect
                value={addRole}
                onChange={setAddRole}
                allowedRoles={
                  calendar.kind === 'primary'
                    ? ['free_busy', 'details']
                    : undefined
                }
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              onPress={() => setMemberPickerOpen(true)}
            >
              {t('manage.addSharedMember')}
            </Button>
          </div>
          {calendar.capabilities.can_delete && (
            <div className={dangerZoneCls}>
              <span className={mutedCls}>{t('manage.deleteRestoreHint')}</span>
              <Button
                variant="quaternaryDanger"
                size="action"
                className={dangerActionBtnCls}
                isDisabled={busy}
                onPress={() =>
                  void act(async () => {
                    await deleteCalendar(calendar.id)
                    onClose()
                  })
                }
              >
                {t('manage.deleteCalendar')}
              </Button>
            </div>
          )}
          {error && <p className={errorCls}>{error}</p>}
        </div>
      </DialogFrame>
      {memberPickerOpen && (
        <BulkAttendeeDialog
          initial={new Map()}
          title={t('manage.addSharedMember')}
          searchPlaceholder={t('manage.searchMember')}
          selectedTitle={(count) => t('manage.selectedCount', { count })}
          confirmLabel={t('manage.add')}
          excludeIds={new Set(members.map((member) => member.user.id))}
          onClose={() => setMemberPickerOpen(false)}
          onConfirm={(selected) => {
            setMemberPickerOpen(false)
            if (selected.size === 0) return
            void act(() =>
              Promise.all(
                [...selected.keys()].map((id) =>
                  addCalendarMember(calendar.id, id, addRole)
                )
              )
            )
          }}
        />
      )}
    </>
  )
}

export const CalendarShareDialog = ({
  calendar,
  onClose,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')
  const [chat, setChat] = useState(false)
  const [error, setError] = useState('')
  const { data, refetch } = useQuery({
    queryKey: ['calendar', calendar.id, 'share-link'],
    queryFn: () => fetchCalendarShareLink(calendar.id),
  })
  const body = JSON.stringify({
    v: 1,
    calendar_id: calendar.id,
    name: calendar.display_name,
    owner_name: calendar.owner?.full_name || calendar.owner?.short_name || '',
    description: calendar.description,
    subscriber_count: calendar.subscriber_count,
    subscribe_url: data?.url || '',
  })
  if (chat && data)
    return (
      <ShareToChatDialog
        body={body}
        contentType="calendar-card"
        previewText={t('manage.sharePreview', { name: calendar.display_name })}
        errorMessage={t('manage.shareFailed')}
        onClose={() => setChat(false)}
      />
    )
  return (
    <DialogFrame
      title={t('manage.shareTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('manage.cancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            isDisabled={!data}
            onPress={() => {
              if (data) void navigator.clipboard.writeText(data.url)
            }}
          >
            {t('manage.copyLink')}
          </Button>
        </>
      }
    >
      <div className={stackCls}>
        <p className={bodyTextCls}>{t('manage.shareHint')}</p>
        {data && (
          <>
            <label className={fieldCls}>
              <span className={eventLabelCls}>{t('manage.shareLink')}</span>
              <input className={eventInputCls} readOnly value={data.url} />
            </label>
            <div className={buttonRowCls}>
              <Button
                variant="secondary"
                size="action"
                onPress={() => setChat(true)}
              >
                {t('manage.shareToChat')}
              </Button>
              <Button
                variant="quaternaryDanger"
                size="action"
                className={dangerActionBtnCls}
                onPress={() =>
                  void resetCalendarShareLink(calendar.id)
                    .then(() => refetch())
                    .catch((reason) => setError(apiErrorMessage(reason)))
                }
              >
                {t('manage.resetLink')}
              </Button>
            </div>
            <div className={qrCls}>
              <QRCodeSVG id="calendar-share-qr" value={data.url} size={220} />
              <span className={mutedCls}>{t('manage.qrNote')}</span>
              <div className={buttonRowCls}>
                <Button
                  variant="secondary"
                  size="action"
                  onPress={() =>
                    void copyQrImage().catch(() =>
                      setError(t('manage.qrFailed'))
                    )
                  }
                >
                  {t('manage.copyQr')}
                </Button>
                <Button
                  variant="secondary"
                  size="action"
                  onPress={() => {
                    try {
                      downloadQrImage(calendar.display_name)
                    } catch {
                      setError(t('manage.qrFailed'))
                    }
                  }}
                >
                  {t('manage.downloadQr')}
                </Button>
              </div>
            </div>
          </>
        )}
        {error && <p className={errorCls}>{error}</p>}
      </div>
    </DialogFrame>
  )
}

export const CalendarExportDialog = ({
  calendar,
  onClose,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')
  const [range, setRange] = useState<'today' | 'week' | 'month' | 'custom'>(
    'week'
  )
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const submitExport = () => {
    setBusy(true)
    setMessage('')
    const payload =
      range === 'custom'
        ? ({ range, timezone, start, end } as const)
        : ({ range, timezone } as const)
    void createCalendarExport(calendar.id, payload)
      .then(() => setMessage(t('manage.exportSubmitted')))
      .catch((reason) => setMessage(apiErrorMessage(reason)))
      .finally(() => setBusy(false))
  }
  return (
    <DialogFrame
      title={t('manage.exportTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('manage.cancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            isDisabled={busy || (range === 'custom' && (!start || !end))}
            onPress={submitExport}
          >
            {t('manage.confirm')}
          </Button>
        </>
      }
    >
      <div className={stackCls}>
        <div className={rangeListCls}>
          {(['today', 'week', 'month', 'custom'] as const).map((value) => (
            <label key={value} className={radioCls}>
              <input
                type="radio"
                checked={range === value}
                onChange={() => setRange(value)}
              />
              {
                {
                  today: t('manage.exportToday'),
                  week: t('manage.exportWeek'),
                  month: t('manage.exportMonth'),
                  custom: t('manage.exportCustom'),
                }[value]
              }
            </label>
          ))}
        </div>
        {range === 'custom' && (
          <div className={dateRangeCls}>
            <label className={fieldCls}>
              <span className={eventLabelCls}>{t('manage.startDate')}</span>
              <input
                type="date"
                className={eventInputCls}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className={fieldCls}>
              <span className={eventLabelCls}>{t('manage.endDate')}</span>
              <input
                type="date"
                className={eventInputCls}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <p className={mutedCls}>{t('manage.exportHint')}</p>
        {message && <p className={statusMessageCls}>{message}</p>}
      </div>
    </DialogFrame>
  )
}

const stackCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
})
const tabsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  marginBottom: '0.75rem',
})
const tabCls = css({
  border: 0,
  background: 'transparent',
  minHeight: 'control.md',
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  fontSize: '0.875rem',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { color: 'greyscale.900' },
})
const activeTabCls = css({
  border: 0,
  borderBottom: '2px solid token(colors.primary.500)',
  background: 'transparent',
  minHeight: 'control.md',
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 'medium',
  color: 'primary.600',
  cursor: 'pointer',
})
// 聚焦描边由 styles/index.css 的「统一焦点描边」统一给出,这里不要再写 _focus。
const textareaCls = css({
  width: '100%',
  minHeight: '3.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  resize: 'vertical',
})
const disabledControlCls = css({
  _disabled: {
    backgroundColor: 'greyscale.100',
    color: 'greyscale.500',
    cursor: 'not-allowed',
  },
})
const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  minHeight: '2.75rem',
  paddingX: '0.25rem',
  paddingY: '0.375rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  _hover: { background: 'greyscale.50' },
})
const growCls = css({
  minWidth: 0,
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
})
const roomNameCls = css({ fontWeight: 'bold' })
const memberRoleCls = css({
  width: '9rem',
  maxWidth: '42%',
  flexShrink: 0,
})
const dotCls = css({
  width: '0.7rem',
  height: '0.7rem',
  borderRadius: '0.2rem',
  flexShrink: 0,
})
const mutedCls = css({ color: 'greyscale.500', fontSize: '0.75rem' })
const errorCls = css({ margin: 0, color: 'danger.600', fontSize: '0.8125rem' })
const buttonRowCls = css({
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap',
  alignItems: 'center',
})
const dangerActionBtnCls = css({
  borderColor: 'danger.300',
  color: 'danger.600',
  whiteSpace: 'nowrap',
})
const sectionTitleCls = css({
  margin: '0.5rem 0 0',
  paddingTop: '0.875rem',
  borderTop: '1px solid token(colors.greyscale.200)',
  fontSize: '0.875rem',
  fontWeight: 'bold',
})
const radioCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: 'control.md',
  fontSize: '0.875rem',
  cursor: 'pointer',
})
const rangeListCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
})
const dateRangeCls = css({
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
})
const qrCls = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.75rem',
  marginTop: '0.25rem',
  paddingTop: '1rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const memberAddRowCls = css({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '0.75rem',
  flexWrap: 'wrap',
  '& > button': { flexShrink: 0 },
})
const dangerZoneCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  marginTop: '0.25rem',
  paddingTop: '0.875rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const bodyTextCls = css({
  margin: 0,
  color: 'greyscale.700',
  fontSize: '0.875rem',
  lineHeight: 1.5,
})
const statusMessageCls = css({
  margin: 0,
  padding: '0.625rem 0.75rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.50',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
})
