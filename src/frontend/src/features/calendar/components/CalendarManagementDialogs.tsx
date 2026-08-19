import { type ReactNode, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'

import { apiErrorMessage } from '@/api/apiErrorMessage'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { MemberAvatar } from '@/features/contacts'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { MeetingRoomSummary } from '@/features/meeting-rooms'
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

const roleLabels: Record<Exclude<CalendarRole, 'none'>, string> = {
  free_busy: '仅忙闲',
  details: '订阅者',
  writer: '编辑者',
  admin: '管理员',
}

type DraftCalendarMember = {
  label: string
  avatarUrl?: string
  role: Exclude<CalendarRole, 'none'>
}

const qrSvgBlob = () => {
  const svg = document.getElementById('calendar-share-qr')
  if (!(svg instanceof SVGElement)) throw new Error('二维码尚未生成')
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
    if (!context) throw new Error('浏览器不支持复制二维码')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('二维码生成失败')),
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
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  maxWidth?: string
}) => (
  <Modal
    onClose={onClose}
    ariaLabel={title}
    maxWidth={maxWidth}
    maxHeight="82vh"
  >
    <header className={headerCls}>
      <h2 className={titleCls}>{title}</h2>
      <ModalCloseButton onClose={onClose} label="关闭" />
    </header>
    <div className={bodyCls}>{children}</div>
    {footer ? <footer className={footerCls}>{footer}</footer> : null}
  </Modal>
)

export const AddCalendarDialog = ({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) => {
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
      title="添加日历"
      onClose={onClose}
      maxWidth="680px"
      footer={
        mode === 'create' ? (
          <>
            <Button variant="secondary" size="action" onPress={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="action"
              isDisabled={busy || !name.trim()}
              onPress={() => void create()}
            >
              保存
            </Button>
          </>
        ) : undefined
      }
    >
      <div className={tabsCls}>
        {(
          [
            ['subscribe', '订阅日历'],
            ['create', '新建日历'],
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
            className={eventInputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索联系人、会议室或公共日历"
          />
          <div className={tabsCls}>
            {(
              [
                ['contact', '联系人'],
                ['room', '会议室'],
                ['public', '公共日历'],
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
            <p className={mutedCls}>正在搜索…</p>
          ) : discoveries.length === 0 ? (
            <p className={mutedCls}>没有可订阅的日历</p>
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
                    {calendar.subscribed ? '取消订阅' : '订阅'}
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
            <span className={eventLabelCls}>日历名称</span>
            <input
              className={eventInputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={fieldCls}>
            <span className={eventLabelCls}>描述</span>
            <textarea
              className={textareaCls}
              value={description}
              maxLength={400}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className={fieldCls}>
            <span className={eventLabelCls}>颜色</span>
            <CalendarColorPicker
              value={color}
              label="颜色"
              onChange={setColor}
            />
          </div>
          <label className={fieldCls}>
            <span className={eventLabelCls}>组织内默认权限</span>
            <select
              className={cx(eventInputCls, selectChrome)}
              value={defaultAccess}
              onChange={(e) =>
                setDefaultAccess(e.target.value as typeof defaultAccess)
              }
            >
              <option value="none">私密</option>
              <option value="free_busy">游客（仅忙闲）</option>
              <option value="details">订阅者（查看详情）</option>
            </select>
          </label>
          <h3 className={sectionTitleCls}>共享人</h3>
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
                移除
              </Button>
            </div>
          ))}
          <div className={memberAddRowCls}>
            <div className={fieldCls}>
              <span className={eventLabelCls}>新增共享人的角色</span>
              <RoleSelect value={memberRole} onChange={setMemberRole} />
            </div>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy}
              onPress={() => setMemberPickerOpen(true)}
            >
              添加共享人
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
        title="添加共享人"
        searchPlaceholder="搜索共享人"
        selectedTitle={(count) => `已选 ${count} 人`}
        confirmLabel="添加"
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
  allowedRoles = Object.keys(roleLabels) as Exclude<CalendarRole, 'none'>[],
}: {
  value: Exclude<CalendarRole, 'none'>
  onChange: (role: Exclude<CalendarRole, 'none'>) => void
  readOnly?: boolean
  allowedRoles?: Exclude<CalendarRole, 'none'>[]
}) => (
  <select
    className={cx(eventInputCls, selectChrome)}
    value={value}
    disabled={readOnly}
    onChange={(event) =>
      onChange(event.target.value as Exclude<CalendarRole, 'none'>)
    }
  >
    {allowedRoles.map((role) => (
      <option key={role} value={role}>
        {roleLabels[role]}
      </option>
    ))}
  </select>
)

export const CalendarSettingsDialog = ({
  calendar,
  onClose,
  onChanged,
}: {
  calendar: UnifiedCalendar
  onClose: () => void
  onChanged: () => void
}) => {
  const qc = useQueryClient()
  const [name, setName] = useState(calendar.display_name)
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
        title="日历设置"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" size="action" onPress={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="action"
              isDisabled={busy || !name.trim()}
              onPress={() => void saveSettings()}
            >
              保存
            </Button>
          </>
        }
      >
        <div className={stackCls}>
          <label className={fieldCls}>
            <span className={eventLabelCls}>日历名称</span>
            <input
              className={cx(eventInputCls, disabledControlCls)}
              disabled={calendar.kind === 'primary'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {calendar.kind === 'primary' && (
              <small className={mutedCls}>个人主日历名称跟随账号名称</small>
            )}
          </label>
          <label className={fieldCls}>
            <span className={eventLabelCls}>描述</span>
            <textarea
              className={textareaCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className={fieldCls}>
            <span className={eventLabelCls}>我的显示颜色</span>
            <CalendarColorPicker
              value={color}
              label="我的显示颜色"
              onChange={setColor}
            />
          </div>
          <label className={fieldCls}>
            <span className={eventLabelCls}>组织内默认权限</span>
            <select
              className={cx(eventInputCls, selectChrome)}
              value={defaultAccess}
              onChange={(e) =>
                setDefaultAccess(e.target.value as typeof defaultAccess)
              }
            >
              <option value="none">私密</option>
              <option value="free_busy">游客（仅忙闲）</option>
              <option value="details">订阅者（查看详情）</option>
            </select>
          </label>
          <p className={mutedCls}>
            组织外默认私密；已建立外部联系的人只能被单独授予只读权限。
          </p>
          <h3 className={sectionTitleCls}>共享人</h3>
          {members.map((member) => (
            <div key={member.id} className={rowCls}>
              <MemberAvatar
                name={
                  member.user.full_name || member.user.short_name || '未知用户'
                }
                src={member.user.avatar_url}
                size="2rem"
              />
              <span className={growCls}>
                {member.user.full_name || member.user.short_name || '未知用户'}
                {member.external ? '（外部联系人）' : ''}
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
                移除
              </Button>
            </div>
          ))}
          <div className={memberAddRowCls}>
            <div className={fieldCls}>
              <span className={eventLabelCls}>新增共享人的角色</span>
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
              添加共享人
            </Button>
          </div>
          {calendar.capabilities.can_delete && (
            <div className={dangerZoneCls}>
              <span className={mutedCls}>删除后 30 天内可恢复。</span>
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
                删除日历
              </Button>
            </div>
          )}
          {error && <p className={errorCls}>{error}</p>}
        </div>
      </DialogFrame>
      {memberPickerOpen && (
        <BulkAttendeeDialog
          initial={new Map()}
          title="添加共享人"
          searchPlaceholder="搜索共享人"
          selectedTitle={(count) => `已选 ${count} 人`}
          confirmLabel="添加"
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
        previewText={`分享日历：${calendar.display_name}`}
        errorMessage="分享日历失败"
        onClose={() => setChat(false)}
      />
    )
  return (
    <DialogFrame
      title="分享日历"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="action" onPress={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="action"
            isDisabled={!data}
            onPress={() => {
              if (data) void navigator.clipboard.writeText(data.url)
            }}
          >
            复制链接
          </Button>
        </>
      }
    >
      <div className={stackCls}>
        <p className={bodyTextCls}>
          分享只邀请对方订阅查看；编辑权限请在“日历设置 → 共享人”中授予。
        </p>
        {data && (
          <>
            <label className={fieldCls}>
              <span className={eventLabelCls}>日历链接</span>
              <input className={eventInputCls} readOnly value={data.url} />
            </label>
            <div className={buttonRowCls}>
              <Button
                variant="secondary"
                size="action"
                onPress={() => setChat(true)}
              >
                分享至会话
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
                重置链接
              </Button>
            </div>
            <div className={qrCls}>
              <QRCodeSVG id="calendar-share-qr" value={data.url} size={220} />
              <span className={mutedCls}>
                Web 可打开；Android App Link 可直接预览并订阅。
              </span>
              <div className={buttonRowCls}>
                <Button
                  variant="secondary"
                  size="action"
                  onPress={() =>
                    void copyQrImage().catch((reason) =>
                      setError(apiErrorMessage(reason))
                    )
                  }
                >
                  复制二维码
                </Button>
                <Button
                  variant="secondary"
                  size="action"
                  onPress={() => downloadQrImage(calendar.display_name)}
                >
                  下载二维码
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
      .then(() => setMessage('导出任务已提交，完成后日历助手会通知你。'))
      .catch((reason) => setMessage(apiErrorMessage(reason)))
      .finally(() => setBusy(false))
  }
  return (
    <DialogFrame
      title="导出日历"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="action" onPress={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="action"
            isDisabled={busy || (range === 'custom' && (!start || !end))}
            onPress={submitExport}
          >
            确定
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
                  today: '今天',
                  week: '本周',
                  month: '本月',
                  custom: '自定义',
                }[value]
              }
            </label>
          ))}
        </div>
        {range === 'custom' && (
          <div className={dateRangeCls}>
            <label className={fieldCls}>
              <span className={eventLabelCls}>开始日期</span>
              <input
                type="date"
                className={eventInputCls}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className={fieldCls}>
              <span className={eventLabelCls}>结束日期</span>
              <input
                type="date"
                className={eventInputCls}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <p className={mutedCls}>
          将异步生成 Docs 原生表格和 CSV
          静态快照；图片、内嵌表格与附件原文件不导出。
        </p>
        {message && <p className={statusMessageCls}>{message}</p>}
      </div>
    </DialogFrame>
  )
}

const headerCls = css({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const bodyCls = css({
  flex: 1,
  minHeight: 0,
  padding: '1rem',
  overflowY: 'auto',
  fontSize: '0.875rem',
  color: 'greyscale.900',
})
const footerCls = css({
  display: 'flex',
  flexShrink: 0,
  justifyContent: 'flex-end',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
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
